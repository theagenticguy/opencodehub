/**
 * `codehub setup --cobol-proleap` — one-time bootstrap for the COBOL
 * deep-parse bridge.
 *
 * The uwol/cobol-parser library is NOT published to Maven Central as of 2026-04
 * (search.maven.org returns 0 hits), and the latest GitHub Release is v2.4.0
 * from 2018 — but master is on v4.x. So we build from source:
 *
 *   1. Probe for `git`, `mvn`, and `javac` (JDK 17+) on PATH. Missing tool
 *      → refuse with a tool-specific install hint.
 *   2. Resolve a temp workdir, `git clone --branch master https://github.com/uwol/cobol-parser`.
 *   3. `mvn install -DskipTests` to build the JAR. Target artifact is
 *      `<tmp>/target/proleap-cobol-parser-<ver>.jar`.
 *   4. `javac -cp <jar> cobol_to_scip.java` — compile the wrapper class
 *      (the `.java` source ships under `packages/cobol-proleap/java/`).
 *   5. Atomic rename the JAR + compiled wrapper into
 *      `~/.codehub/vendor/proleap/{proleap-cobol-parser-<ver>.jar,
 *      cobol_to_scip.class}`.
 *
 * Every external-tool spawn goes through the `ProcessApi` seam so tests
 * can stub the whole pipeline without shelling out for real.
 */

import { spawn } from "node:child_process";
import {
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  mkdtemp as fsMkdtemp,
  readdir as fsReaddir,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COBOL_PROLEAP_REPO_URL = "https://github.com/uwol/cobol-parser";
export const COBOL_PROLEAP_BRANCH = "master";
export const MIN_JAVAC_MAJOR = 17;

/** Process-spawn + fs seam. Tests replace with in-memory doubles. */
export interface ProcessApi {
  run(cmd: string, args: readonly string[], cwd?: string): Promise<ProcessResult>;
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
}

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const DEFAULT_PROCESS_API: ProcessApi = {
  run(cmd, args, cwd) {
    return new Promise((res) => {
      const child = spawn(cmd, args as string[], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdout += d;
      });
      child.stderr.on("data", (d: string) => {
        stderr += d;
      });
      child.on("error", (err) => {
        res({ code: -1, stdout, stderr: `${err.message}\n${stderr}` });
      });
      child.on("exit", (code) => {
        res({ code: code ?? -1, stdout, stderr });
      });
    });
  },
  async mkdtemp(prefix) {
    return await fsMkdtemp(join(tmpdir(), prefix));
  },
  async mkdir(path) {
    await fsMkdir(path, { recursive: true });
  },
  async copyFile(src, dest) {
    await fsCopyFile(src, dest);
  },
  async rename(src, dest) {
    await fsRename(src, dest);
  },
  async rm(path, opts) {
    await fsRm(path, { recursive: opts?.recursive ?? false, force: opts?.force ?? false });
  },
  async readdir(path) {
    return await fsReaddir(path);
  },
  async exists(path) {
    try {
      await fsStat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  },
};

export interface SetupCobolProleapOptions {
  /** Override the install dir. Default: `~/.codehub/vendor/proleap`. */
  readonly vendorDir?: string;
  /** Override the user home dir. Default: os.homedir(). */
  readonly home?: string;
  /** Override the Java source path. Default: resolved relative to the installed cli. */
  readonly javaSourcePath?: string;
  /** Force re-install even if the vendor dir already has a JAR. */
  readonly force?: boolean;
  /** Process / fs seam for tests. */
  readonly processApi?: ProcessApi;
  /** Structured logger. Defaults to `console.warn`. */
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface SetupCobolProleapResult {
  readonly jarPath: string;
  readonly wrapperClassPath: string;
  readonly vendorDir: string;
  readonly installed: boolean;
  readonly skipped: boolean;
}

/**
 * Run the setup. Returns the final install paths (jar + wrapper classpath
 * dir) so the analyze runner can resolve them without re-walking the
 * vendor dir. Throws on precondition failure with tool-specific install
 * hints so the user can self-serve.
 */
export async function runSetupCobolProleap(
  opts: SetupCobolProleapOptions = {},
): Promise<SetupCobolProleapResult> {
  const proc = opts.processApi ?? DEFAULT_PROCESS_API;
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const vendorDir = opts.vendorDir ?? defaultVendorDir(opts.home);
  const jarTarget = join(vendorDir, "proleap-cobol-parser.jar");
  const wrapperClassDir = vendorDir;
  const wrapperClass = join(wrapperClassDir, "cobol_to_scip.class");

  if (opts.force !== true) {
    if ((await proc.exists(jarTarget)) && (await proc.exists(wrapperClass))) {
      log(`codehub setup --cobol-proleap: already installed at ${vendorDir}`);
      return {
        jarPath: jarTarget,
        wrapperClassPath: wrapperClassDir,
        vendorDir,
        installed: false,
        skipped: true,
      };
    }
  }

  // --- Precondition probes ------------------------------------------------
  await requireToolOrThrow(proc, "git", ["--version"], "git", undefined);
  await requireToolOrThrow(proc, "mvn", ["--version"], "maven (mvn)", undefined);
  await requireToolOrThrow(proc, "javac", ["--version"], "JDK (javac)", MIN_JAVAC_MAJOR);

  // --- Build from source --------------------------------------------------
  const workDir = await proc.mkdtemp("codehub-proleap-");
  const srcDir = join(workDir, "cobol-parser");
  log(
    `codehub setup --cobol-proleap: git clone ${COBOL_PROLEAP_REPO_URL} (${COBOL_PROLEAP_BRANCH})`,
  );
  const clone = await proc.run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    COBOL_PROLEAP_BRANCH,
    COBOL_PROLEAP_REPO_URL,
    srcDir,
  ]);
  if (clone.code !== 0) {
    await cleanup(proc, workDir);
    throw new Error(
      `codehub setup --cobol-proleap: git clone failed (code ${clone.code}): ${clone.stderr.slice(-400)}`,
    );
  }

  log("codehub setup --cobol-proleap: mvn install -DskipTests (this takes a minute)");
  const mvn = await proc.run("mvn", ["install", "-DskipTests", "-q"], srcDir);
  if (mvn.code !== 0) {
    await cleanup(proc, workDir);
    throw new Error(
      `codehub setup --cobol-proleap: mvn build failed (code ${mvn.code}): ${mvn.stderr.slice(-400)}`,
    );
  }

  // Locate the target/proleap-cobol-parser-<ver>.jar.
  const targetDir = join(srcDir, "target");
  const targetFiles = await proc.readdir(targetDir);
  const builtJar = targetFiles.find(
    (n) =>
      n.startsWith("proleap-cobol-parser-") && n.endsWith(".jar") && !n.endsWith("-sources.jar"),
  );
  if (builtJar === undefined) {
    await cleanup(proc, workDir);
    throw new Error(
      `codehub setup --cobol-proleap: mvn finished but no proleap-cobol-parser-*.jar in ${targetDir}`,
    );
  }
  const builtJarPath = join(targetDir, builtJar);

  // --- Compile the wrapper ------------------------------------------------
  const javaSource = opts.javaSourcePath ?? resolveWrapperJavaSource();
  if (!(await proc.exists(javaSource))) {
    await cleanup(proc, workDir);
    throw new Error(
      `codehub setup --cobol-proleap: wrapper Java source not found at ${javaSource}. ` +
        "Re-install @opencodehub/cobol-proleap or pass --java-source.",
    );
  }
  // Compile into the workDir so a failure doesn't pollute vendor/.
  const compileDir = join(workDir, "wrapper");
  await proc.mkdir(compileDir);
  // Copy the .java file so javac's output lands next to the source.
  const workJava = join(compileDir, "cobol_to_scip.java");
  await proc.copyFile(javaSource, workJava);
  const javac = await proc.run("javac", ["-cp", builtJarPath, "-d", compileDir, workJava]);
  if (javac.code !== 0) {
    await cleanup(proc, workDir);
    throw new Error(
      `codehub setup --cobol-proleap: javac failed (code ${javac.code}): ${javac.stderr.slice(-400)}`,
    );
  }
  const wrapperClassBuilt = join(compileDir, "cobol_to_scip.class");
  if (!(await proc.exists(wrapperClassBuilt))) {
    await cleanup(proc, workDir);
    throw new Error(
      "codehub setup --cobol-proleap: javac succeeded but cobol_to_scip.class was not produced",
    );
  }

  // --- Atomic install -----------------------------------------------------
  await proc.mkdir(vendorDir);
  // Rename rather than copy so the final JAR lands in one syscall; fall
  // back to copyFile for cross-filesystem temp dirs where rename would
  // fail with EXDEV.
  try {
    await proc.rename(builtJarPath, jarTarget);
  } catch {
    await proc.copyFile(builtJarPath, jarTarget);
  }
  try {
    await proc.rename(wrapperClassBuilt, wrapperClass);
  } catch {
    await proc.copyFile(wrapperClassBuilt, wrapperClass);
  }
  await cleanup(proc, workDir);

  log(
    `codehub setup --cobol-proleap: installed ${jarTarget} (v${extractVersion(builtJar)}) and ` +
      `cobol_to_scip.class at ${vendorDir}`,
  );
  log(
    "codehub setup --cobol-proleap: Done. " +
      "Pass --allow-build-scripts=proleap to `codehub analyze`.",
  );
  return {
    jarPath: jarTarget,
    wrapperClassPath: wrapperClassDir,
    vendorDir,
    installed: true,
    skipped: false,
  };
}

/** Default vendor dir. */
export function defaultVendorDir(home?: string): string {
  return join(home ?? homedir(), ".codehub", "vendor", "proleap");
}

/**
 * Probe a tool. Throws an Error (containing a user-facing install hint) when
 * the binary is missing or too old. `minMajor` is non-undefined only for
 * javac today — the major-version parse is reused from the JRE probe shape.
 */
async function requireToolOrThrow(
  proc: ProcessApi,
  cmd: string,
  args: readonly string[],
  friendly: string,
  minMajor: number | undefined,
): Promise<void> {
  const out = await proc.run(cmd, args);
  if (out.code !== 0) {
    throw new Error(
      `codehub setup --cobol-proleap: ${friendly} not on PATH (tried \`${cmd} ${args.join(" ")}\`). ` +
        installHint(friendly),
    );
  }
  if (minMajor !== undefined) {
    const combined = `${out.stdout}\n${out.stderr}`;
    const major = parseMajor(combined);
    if (major === undefined || major < minMajor) {
      throw new Error(
        `codehub setup --cobol-proleap: ${friendly} < ${minMajor} detected (${combined.trim().slice(0, 120)}). ` +
          installHint(friendly),
      );
    }
  }
}

function installHint(friendly: string): string {
  if (friendly.startsWith("git")) {
    return "Install git from https://git-scm.com/downloads, then retry.";
  }
  if (friendly.startsWith("maven")) {
    return "Install Maven 3.8+ (`brew install maven` on macOS, `apt install maven` on Debian), then retry.";
  }
  if (friendly.startsWith("JDK")) {
    return (
      `Install a JDK ${MIN_JAVAC_MAJOR}+ (e.g. \`brew install openjdk@${MIN_JAVAC_MAJOR}\` or ` +
      `\`apt install openjdk-${MIN_JAVAC_MAJOR}-jdk\`), then retry.`
    );
  }
  return "";
}

function parseMajor(output: string): number | undefined {
  const legacy = output.match(/\b1\.(\d+)(?:\.[\d_]+)?\b/);
  if (legacy?.[1] !== undefined) {
    const parsed = Number.parseInt(legacy[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const modern = output.match(/\b(\d{2,3})(?:\.\d+)?\b/);
  if (modern?.[1] !== undefined) {
    const parsed = Number.parseInt(modern[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractVersion(jarName: string): string {
  const m = jarName.match(/proleap-cobol-parser-([\d.]+)/);
  return m?.[1] ?? "unknown";
}

async function cleanup(proc: ProcessApi, dir: string): Promise<void> {
  try {
    await proc.rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Resolve the wrapper Java source shipped in @opencodehub/cobol-proleap.
 * Walks up from the installed CLI until it finds
 * `packages/cobol-proleap/java/cobol_to_scip.java` (repo checkout) or
 * `node_modules/@opencodehub/cobol-proleap/java/cobol_to_scip.java` (installed).
 */
function resolveWrapperJavaSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const dir = dirname(thisFile);
  const candidates = [
    () => join(dir, "..", "..", "cobol-proleap", "java", "cobol_to_scip.java"),
    () => join(dir, "..", "..", "..", "cobol-proleap", "java", "cobol_to_scip.java"),
    () =>
      join(
        dir,
        "..",
        "..",
        "..",
        "..",
        "@opencodehub",
        "cobol-proleap",
        "java",
        "cobol_to_scip.java",
      ),
  ];
  for (const fn of candidates) {
    const p = resolve(fn());
    // Sync existsSync is fine in this pre-flight path.
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(p)) return p;
  }
  // Fall back to the conventional repo layout; caller reports a clean
  // "wrapper Java source not found" error if it's missing on disk.
  return resolve(dir, "..", "..", "cobol-proleap", "java", "cobol_to_scip.java");
}
