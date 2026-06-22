/**
 * Parity tests for the business-logic feature extractor against the Python
 * oracle `och_bizlogic_extract.py`. Each test fixes the expected feature value
 * to the value the Python emits for the same snippet (captured by running the
 * Python `_extract_one` on each case), then asserts the TS port reproduces it.
 *
 * The four fields under test are exactly the ones the merged kernel
 * (`@opencodehub/analysis` `classifyPlumbing`) consumes, so a passing suite
 * means the shipped sieve verdict agrees with the Python substrate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computePlumbingFeatures } from "./business-logic-features.js";

function py(bodyText: string, symbolName: string, kind = "Function", classHeadText?: string) {
  return computePlumbingFeatures({
    symbolName,
    kind,
    bodyText,
    lang: "python",
    ...(classHeadText !== undefined ? { classHeadText } : {}),
  });
}

// ── serialization calls ─────────────────────────────────────────────────────

test("serialization: json.dumps(...) counts one serialization call", () => {
  const f = py("def to_wire(self):\n    return json.dumps(self.payload)\n", "to_wire");
  assert.equal(f.nSerializationCalls, 1);
});

test("serialization: self.model_dump() counts one serialization call", () => {
  const f = py("def out(self):\n    return self.model_dump()\n", "out");
  assert.equal(f.nSerializationCalls, 1);
});

test("serialization: nested log.info(json.dumps(x)) — ser=2, observ folds into plumbing", () => {
  // Oracle: outer call head contains json/dumps (+1 ser) AND info/log (+1 observ);
  // inner json.dumps(...) (+1 ser). So nSerializationCalls = 2.
  const f = py("def emit(self):\n    log.info(json.dumps(self.x))\n", "emit");
  assert.equal(f.nSerializationCalls, 2);
  // observ call present → plumbing signal ≥ 1.
  assert.ok(f.nPlumbingSignals >= 1);
});

test("serialization: a non-serializer call counts zero", () => {
  const f = py("def go(self):\n    self.do_work(self.x)\n", "go");
  assert.equal(f.nSerializationCalls, 0);
});

// ── domain conditionals vs guards ───────────────────────────────────────────

test("domain conditional: value comparison is a domain signal", () => {
  const f = py(
    "def check(self, amount):\n    if amount > self.limit:\n        return True\n",
    "check",
  );
  assert.equal(f.nDomainSignals, 1);
});

test("guard: `if x is None` is NOT a domain conditional", () => {
  const f = py("def check(self, x):\n    if x is None:\n        return 0\n    return x\n", "check");
  assert.equal(f.nDomainSignals, 0);
});

test("guard: `if isinstance(x, int)` is NOT a domain conditional", () => {
  const f = py("def f(self, x):\n    if isinstance(x, int):\n        pass\n", "f");
  assert.equal(f.nDomainSignals, 0);
});

test("guard: `if len(x) > 0` is NOT a domain conditional (len is a guard token)", () => {
  const f = py("def f(self, x):\n    if len(x) > 0:\n        pass\n", "f");
  assert.equal(f.nDomainSignals, 0);
});

test("conditional: elif does NOT add a second conditional (elif is a separate node)", () => {
  const f = py(
    "def f(self, x):\n    if x > 5:\n        pass\n    elif x < 2:\n        pass\n",
    "f",
  );
  assert.equal(f.nDomainSignals, 1);
});

test("conditional: two separate if statements count two", () => {
  const f = py("def f(self, x):\n    if x > 5:\n        pass\n    if x < 2:\n        pass\n", "f");
  assert.equal(f.nDomainSignals, 2);
});

// ── arithmetic ───────────────────────────────────────────────────────────────

test("arithmetic: `a + b` is one domain signal", () => {
  const f = py("def f(self, a, b):\n    return a + b\n", "f");
  assert.equal(f.nDomainSignals, 1);
});

test("arithmetic: `a + b * 2` is two domain signals (two binary ops)", () => {
  const f = py("def total(self, a, b):\n    return a + b * 2\n", "total");
  assert.equal(f.nDomainSignals, 2);
});

test("arithmetic: a bare comparison `a > b` is NOT arithmetic", () => {
  const f = py("def f(self, a, b):\n    return a > b\n", "f");
  assert.equal(f.nDomainSignals, 0);
});

test("arithmetic: augmented assignment `-=` is NOT counted as arithmetic", () => {
  // Oracle: `self.balance_due -= amount` → n_arithmetic_ops = 0.
  const f = py("def f(self):\n    self.balance_due -= amount\n", "pay");
  assert.equal(f.nDomainSignals, 0);
});

// ── domain exceptions vs stdlib ─────────────────────────────────────────────

test("domain exception: raising InsufficientFundsError is a domain signal", () => {
  const f = py(
    "def withdraw(self, amount):\n    if amount > self.balance:\n        raise InsufficientFundsError(amount)\n",
    "withdraw",
  );
  // 1 conditional (amount > balance) + 1 domain exception = 2.
  assert.equal(f.nDomainSignals, 2);
});

test("stdlib exception: raising ValueError is NOT a domain signal", () => {
  const f = py("def parse(self, x):\n    raise ValueError('bad')\n", "do_parse");
  assert.equal(f.nDomainSignals, 0);
});

test("domain exceptions: two distinct domain raises count two", () => {
  const f = py(
    "def f(self):\n    raise PaymentDeclinedError('x')\n    raise OrderConflict('y')\n",
    "f",
  );
  assert.equal(f.nDomainSignals, 2);
});

// ── state transitions ───────────────────────────────────────────────────────

test("state transition: assigning self.status is a domain signal", () => {
  const f = py("def advance(self):\n    self.status = self.next_status\n", "advance", "Method");
  assert.equal(f.nDomainSignals, 1);
});

test("state transition: assigning self.state (no RHS dot) is a domain signal", () => {
  const f = py("def advance(self):\n    self.state = 5\n", "advance", "Method");
  assert.equal(f.nDomainSignals, 1);
});

// ── qualified persistence / raw-SQL / bootstrap are NOT in nPlumbingSignals ──
//
// The shipped kernel reads ONLY nSerializationCalls / nDomainSignals /
// nPlumbingSignals / isOrmModel, and the Python `n_plumbing_signals` (lines
// 767-769) is composed EXACTLY as
//   n_serialization_calls + n_observ_calls + (is_getter_setter?1:0)
//                                          + (dto_mapper_ratio>=0.5?1:0).
// Qualified-persistence / raw-SQL / bootstrap-name feed the Python's
// `touches_persistence` / `is_framework_bootstrap` fields, which the kernel does
// NOT consume — so they do NOT enter nPlumbingSignals. The expected values below
// were captured by running the Python oracle `_extract_one` on each snippet.

test("persistence: session.execute(...) is NOT in nPlumbingSignals (feeds touches_persistence)", () => {
  // Oracle: ser=0 obs=0 gs=False dto=0 → n_plumbing_signals = 0.
  const f = py("def save(self):\n    self.session.execute('foo')\n    db.commit()\n", "save");
  assert.equal(f.nPlumbingSignals, 0);
  assert.equal(f.nDomainSignals, 0);
});

test("persistence: a BARE verb `update(self.x)` is NOT a plumbing signal", () => {
  const f = py("def thing(self):\n    update(self.x)\n", "thing");
  assert.equal(f.nPlumbingSignals, 0);
});

test("persistence: `self.repo.get(ref)` does NOT enter nPlumbingSignals (qualified persistence is excluded)", () => {
  // Oracle: ser=0 obs=0 gs=False (has a call) dto=0 → n_plumbing_signals = 0.
  const f = py("def fetch(self, ref):\n    return self.repo.get(ref)\n", "fetch");
  assert.equal(f.nPlumbingSignals, 0);
});

test("persistence: Flask web `session.get('_flashes')` is dict access, NOT persistence", () => {
  const f = py(
    "def flash(message):\n    flashes = session.get('_flashes', [])\n    return flashes\n",
    "do_flash",
  );
  assert.equal(f.nPlumbingSignals, 0);
});

test("persistence: `context.update(...)` is NOT persistence (ctx is not a DB receiver)", () => {
  const f = py(
    "def update_template_context(self, context):\n    context.update(self.dispatch(name))\n    return context\n",
    "update_template_context",
  );
  assert.equal(f.nPlumbingSignals, 0);
});

// ── raw SQL is NOT in nPlumbingSignals (feeds touches_persistence) ───────────

test("raw SQL: SELECT ... FROM does NOT enter nPlumbingSignals", () => {
  // Oracle: raw-SQL feeds touches_persistence, not n_plumbing_signals → 0.
  const f = py("def q(self):\n    cur.execute('SELECT id FROM users WHERE x = 1')\n", "q");
  assert.equal(f.nPlumbingSignals, 0);
});

test("raw SQL: INSERT INTO does NOT enter nPlumbingSignals", () => {
  // Oracle: raw-SQL feeds touches_persistence, not n_plumbing_signals → 0.
  const f = py('def do_add(self):\n    run("INSERT INTO user (name) VALUES (?)")\n', "do_add");
  assert.equal(f.nPlumbingSignals, 0);
});

// ── observability ────────────────────────────────────────────────────────────

test("observability: logger.info(...) is a plumbing signal", () => {
  const f = py("def run(self):\n    logger.info('hi')\n", "run");
  assert.ok(f.nPlumbingSignals >= 1);
  assert.equal(f.nDomainSignals, 0);
});

// ── bootstrap name is NOT in nPlumbingSignals (feeds is_framework_bootstrap) ──

test("bootstrap: create_app does NOT enter nPlumbingSignals (bootstrap is excluded)", () => {
  // Oracle: ser=0 obs=0 gs=False (loc 4, has calls) dto=0 → n_plumbing_signals = 0.
  const f = py(
    "def create_app(config=None):\n    app = Flask(__name__)\n    app.config.update(config or {})\n    return app\n",
    "create_app",
  );
  assert.equal(f.nPlumbingSignals, 0);
});

test("getter/setter: `to_wire` is a plumbing signal because it is a getter/setter", () => {
  // Oracle: is_getter_setter == True (loc 2, no conditionals, <=1 return, 0 calls)
  // → n_plumbing_signals = 1. (The old `wire` bootstrap path is NOT why it fires.)
  const f = py("def to_wire(self):\n    return self.x\n", "to_wire");
  assert.equal(f.nPlumbingSignals, 1);
});

test("getter/setter: a tiny pass-through `allocate` IS a getter/setter (loc<=3, no cond, <=1 return, 0 calls)", () => {
  // Oracle: gs=True → n_plumbing_signals = 1. A plain bootstrap NAME never enters
  // the formula, but this tiny pass-through trips the getter/setter tell.
  const f = py("def allocate(self):\n    return self.x\n", "allocate");
  assert.equal(f.nPlumbingSignals, 1);
});

test("bootstrap WITH domain residue: register_payment carries domain residue and no plumbing tell", () => {
  // Oracle: n_domain_signals = 2 (the `amount > balance_due` conditional + the
  // raised OverpaymentError). bootstrap-name does NOT enter n_plumbing_signals,
  // and there is no serializer / observ / getter-setter / dto tell → plumb = 0.
  const f = py(
    "def register_payment(self, amount):\n    if amount > self.balance_due:\n        raise OverpaymentError(amount)\n    self.balance_due -= amount\n",
    "register_payment",
    "Method",
  );
  assert.equal(f.nDomainSignals, 2);
  assert.equal(f.nPlumbingSignals, 0);
});

// ── ORM base-class match vs flask false positive ────────────────────────────

test("ORM: class User(Base) is an ORM model (exact base superclass)", () => {
  const f = py("pass\n", "User", "Class", "class User(Base):");
  assert.equal(f.isOrmModel, true);
});

test("ORM: class Order(Model) is an ORM model", () => {
  const f = py("pass\n", "Order", "Class", "class Order(Model):");
  assert.equal(f.isOrmModel, true);
});

test("ORM false positive guard: class Request(RequestBase) is NOT an ORM model", () => {
  // The precision fix: `Base` matches ONLY as an exact superclass identifier,
  // never as a component of `RequestBase`.
  const f = py("pass\n", "Request", "Class", "class Request(RequestBase):");
  assert.equal(f.isOrmModel, false);
});

test("ORM: UserEntity (component role in the name) is an ORM model", () => {
  const f = py("pass\n", "UserEntity", "Class", "class UserEntity:");
  assert.equal(f.isOrmModel, true);
});

test("ORM: pydantic BaseModel base is dropped — class UserDTO(BaseModel) is NOT an ORM model", () => {
  const f = py("pass\n", "UserDTO", "Class", "class UserDTO(BaseModel):");
  assert.equal(f.isOrmModel, false);
});

test("ORM: AbstractRepository(abc.ABC) is infra plumbing, NOT an ORM model", () => {
  // Repository is an infra ROLE component → is_orm_model is False (it is
  // plumbing, but not a mapped entity).
  const f = py(
    "def add(self, p):\n    self._add(p)\n",
    "AbstractRepository",
    "Class",
    "class AbstractRepository(abc.ABC):",
  );
  assert.equal(f.isOrmModel, false);
});

// ── Java / Go class-head + persistence parity ───────────────────────────────

test("java ORM: @Entity class Owner extends BaseEntity is an ORM model", () => {
  const f = computePlumbingFeatures({
    symbolName: "Owner",
    kind: "Class",
    bodyText: "",
    classHeadText: "@Entity\nclass Owner extends BaseEntity",
    lang: "java",
  });
  assert.equal(f.isOrmModel, true);
});

test("java infra: interface OwnerRepository extends JpaRepository is NOT an ORM model", () => {
  const f = computePlumbingFeatures({
    symbolName: "OwnerRepository",
    kind: "Class",
    bodyText: "",
    classHeadText: "interface OwnerRepository extends JpaRepository<Owner, Integer>",
    lang: "java",
  });
  assert.equal(f.isOrmModel, false);
});

test("java persistence: em.persist(entity) does NOT enter nPlumbingSignals", () => {
  // Oracle: qualified persistence feeds touches_persistence, not the kernel's
  // n_plumbing_signals (ser=0 obs=0 gs=False dto=0) → 0.
  const f = computePlumbingFeatures({
    symbolName: "save",
    kind: "Method",
    bodyText: "void save() {\n    em.persist(entity);\n}",
    lang: "java",
  });
  assert.equal(f.nPlumbingSignals, 0);
});

test("go persistence: uc.repo.Store(ctx, &task) does NOT enter nPlumbingSignals", () => {
  // Oracle: qualified persistence feeds touches_persistence, not the kernel's
  // n_plumbing_signals (ser=0 obs=0 gs=False dto=0) → 0.
  const f = computePlumbingFeatures({
    symbolName: "Create",
    kind: "Method",
    bodyText:
      "func (uc *UseCase) Create(ctx context.Context) error {\n    err := uc.repo.Store(ctx, &task)\n    return err\n}",
    lang: "go",
  });
  assert.equal(f.nPlumbingSignals, 0);
});

test("go: no raise/throw, so a domain-exception scan is zero", () => {
  const f = computePlumbingFeatures({
    symbolName: "Run",
    kind: "Function",
    bodyText: "func Run() {\n    panic(MyDomainError{})\n}",
    lang: "go",
  });
  // Go has no raise node — domain exceptions are 0 regardless of the name.
  assert.equal(f.nDomainSignals, 0);
});

// ── end-to-end kernel agreement spot-check ──────────────────────────────────

test("kernel agreement: a pure serializer is swept (ser>0, domain=0)", () => {
  const f = py("def to_wire(self):\n    return json.dumps(self.payload)\n", "marshal_out");
  assert.equal(f.nSerializationCalls, 1);
  assert.equal(f.nDomainSignals, 0);
});

test("kernel agreement: a domain method is NOT swept (domain>0)", () => {
  const f = py(
    "def allocate(self, line):\n    if self.can_allocate(line):\n        return line.qty * self.unit_price\n",
    "allocate",
    "Method",
  );
  assert.ok(f.nDomainSignals > 0);
});
