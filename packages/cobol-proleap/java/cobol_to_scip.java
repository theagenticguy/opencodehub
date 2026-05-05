/*
 * cobol_to_scip.java — JVM wrapper over the uwol/cobol-parser library
 * (v4.0.0, package prefix io.proleap.cobol). Reads file paths on stdin,
 * parses each one via the library runner, walks the ASG, and emits one
 * NDJSON record per discovered construct on stdout.
 *
 * Record shape matches src/types.ts CobolDeepElement:
 *   { "kind": "program-id"|"paragraph"|"perform"|"copy"|"cics"
 *            |"data-item"|"file-descriptor",
 *     "name": string, "filePath": string,
 *     "startLine": int, "endLine": int }
 *
 * On a single-file parse crash we emit:
 *   { "kind": "diagnostic", "filePath": string, "message": string }
 * and continue to the next path so one bad file can't wedge the batch.
 *
 * NO external dependencies beyond the cobol-parser JAR and the JDK. Compile
 * against the JAR with:
 *   javac -cp /path/to/proleap-cobol-parser-4.0.0.jar cobol_to_scip.java
 *
 * The ASG traversal uses reflection rather than imports of the
 * io.proleap.cobol.asg.* types so this source compiles in every
 * environment that has the JAR on the classpath, regardless of the exact
 * v4.x point release. Reflection keeps the wrapper resilient across the
 * minor ASG reshuffles the library has shipped.
 */

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

public class cobol_to_scip {

    // Canonical ASG API entry point. The runner class has a
    // `analyzeFile(File, CobolSourceFormatEnum)` method that returns a
    // `io.proleap.cobol.asg.metamodel.Program` root. We hold the types by
    // name to avoid a compile-time dependency on any single point release.
    private static final String RUNNER_CLASS =
        "io.proleap.cobol.asg.runner.impl.CobolParserRunnerImpl";
    private static final String FORMAT_ENUM =
        "io.proleap.cobol.preprocessor.CobolPreprocessor$CobolSourceFormatEnum";

    public static void main(String[] args) throws Exception {
        // Verify the library classpath is present; if not, surface a clear
        // error rather than a generic ClassNotFoundException stack.
        final Class<?> runnerClass;
        final Class<?> formatClass;
        try {
            runnerClass = Class.forName(RUNNER_CLASS);
            formatClass = Class.forName(FORMAT_ENUM);
        } catch (ClassNotFoundException e) {
            System.err.println(
                "cobol_to_scip: required class " + e.getMessage()
                    + " not on classpath. Expected the uwol/cobol-parser JAR "
                    + "(v4.0.0) on -cp. Re-run `codehub setup --cobol-proleap`.");
            System.exit(2);
            return;
        }

        final Object runner = runnerClass.getDeclaredConstructor().newInstance();
        final Method analyzeFile = runnerClass.getMethod("analyzeFile", File.class, formatClass);
        final Object formatFixed = Enum.valueOf(formatClass.asSubclass(Enum.class), "FIXED");

        try (BufferedReader in = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                String path = line.trim();
                if (path.isEmpty()) continue;
                try {
                    Object program = analyzeFile.invoke(runner, new File(path), formatFixed);
                    walkProgram(program, path);
                } catch (Throwable t) {
                    // Per-file isolation: never let a single parse failure
                    // kill the batch. The TS wrapper treats the diagnostic
                    // record as a fallback-trigger for this path.
                    Throwable cause = unwrap(t);
                    emitDiagnostic(path, cause.getClass().getSimpleName() + ": " + cause.getMessage());
                }
            }
        }
    }

    /**
     * Walk a Program ASG and emit NDJSON records. Uses reflection against the
     * io.proleap.cobol.asg.metamodel.* API: Program.getCompilationUnits()
     * returns a List<CompilationUnit>; each CompilationUnit holds a
     * ProgramUnit which holds the four divisions (IDENTIFICATION,
     * ENVIRONMENT, DATA, PROCEDURE). We extract:
     *   - PROGRAM-ID from the IDENTIFICATION division
     *   - Paragraph + PERFORM call sites from the PROCEDURE division
     *   - COPY statements from the compilation unit's copybook list
     *
     * The traversal is intentionally shallow — the regex hot path already
     * provides CICS spans and a working coverage floor; the deep-parse value
     * is in the authoritative ASG edges (paragraph → perform target,
     * copybook resolution). Richer node kinds (data-item, file-descriptor)
     * will follow once we have fixtures that exercise them.
     */
    static void walkProgram(Object program, String path) throws Exception {
        if (program == null) {
            emitDiagnostic(path, "runner returned null Program");
            return;
        }
        Iterable<?> compilationUnits = (Iterable<?>) call(program, "getCompilationUnits");
        if (compilationUnits == null) return;
        for (Object cu : compilationUnits) {
            String cuName = (String) call(cu, "getName");
            // Each CompilationUnit exposes its primary ProgramUnit plus any
            // copybook inclusions; we only map the program unit in this
            // first-pass implementation.
            Object programUnit = call(cu, "getProgramUnit");
            if (programUnit == null) continue;

            // IDENTIFICATION DIVISION → PROGRAM-ID.
            Object idDivision = call(programUnit, "getIdentificationDivision");
            if (idDivision != null) {
                Object programIdPara = call(idDivision, "getProgramIdParagraph");
                if (programIdPara != null) {
                    String name = asString(call(programIdPara, "getName"));
                    if (name == null) name = cuName != null ? cuName : "UNKNOWN";
                    int[] lines = lineSpan(programIdPara);
                    emitRecord("program-id", name, path, lines[0], lines[1]);
                }
            }

            // PROCEDURE DIVISION → paragraphs + PERFORMs.
            Object procDivision = call(programUnit, "getProcedureDivision");
            if (procDivision != null) {
                Iterable<?> paragraphs = (Iterable<?>) call(procDivision, "getParagraphs");
                if (paragraphs != null) {
                    for (Object para : paragraphs) {
                        String name = asString(call(para, "getName"));
                        if (name == null) continue;
                        int[] lines = lineSpan(para);
                        emitRecord("paragraph", name, path, lines[0], lines[1]);
                    }
                }
                Iterable<?> performs = (Iterable<?>) call(procDivision, "getPerformStatements");
                if (performs != null) {
                    for (Object perf : performs) {
                        String target = asString(call(perf, "getProcedureName"));
                        if (target == null) continue;
                        int[] lines = lineSpan(perf);
                        emitRecord("perform", target, path, lines[0], lines[1]);
                    }
                }
            }

            // Copybook references — recorded on the CompilationUnit itself.
            Iterable<?> copies = (Iterable<?>) call(cu, "getCopyStatements");
            if (copies != null) {
                for (Object copy : copies) {
                    String target = asString(call(copy, "getCopybookName"));
                    if (target == null) continue;
                    int[] lines = lineSpan(copy);
                    emitRecord("copy", target, path, lines[0], lines[1]);
                }
            }
        }
    }

    /**
     * Reflective getter — the ASG types are interface-heavy and the method
     * set changes slightly between maintenance releases. We tolerate a
     * missing method by returning null rather than crashing the batch.
     */
    static Object call(Object target, String method) {
        if (target == null) return null;
        try {
            Method m = target.getClass().getMethod(method);
            return m.invoke(target);
        } catch (NoSuchMethodException e) {
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Pull a (startLine, endLine) span out of a node's source-context. The
     * ASG exposes `getCtx().getStart().getLine()` / `getCtx().getStop().getLine()`
     * on the ANTLR parse tree, since the library uses ANTLR4 under the hood.
     */
    static int[] lineSpan(Object node) {
        Object ctx = call(node, "getCtx");
        if (ctx == null) return new int[] {1, 1};
        Object start = call(ctx, "getStart");
        Object stop = call(ctx, "getStop");
        int startLine = start == null ? 1 : intValue(call(start, "getLine"), 1);
        int stopLine = stop == null ? startLine : intValue(call(stop, "getLine"), startLine);
        return new int[] {startLine, stopLine};
    }

    static int intValue(Object v, int fallback) {
        if (v instanceof Number) return ((Number) v).intValue();
        return fallback;
    }

    static String asString(Object v) {
        return v == null ? null : v.toString();
    }

    static Throwable unwrap(Throwable t) {
        Throwable cur = t;
        while (cur.getCause() != null && cur.getCause() != cur) cur = cur.getCause();
        return cur;
    }

    static void emitRecord(String kind, String name, String path, int startLine, int endLine) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("{\"kind\":\"").append(escape(kind)).append("\",")
          .append("\"name\":\"").append(escape(name)).append("\",")
          .append("\"filePath\":\"").append(escape(path)).append("\",")
          .append("\"startLine\":").append(startLine).append(",")
          .append("\"endLine\":").append(endLine).append("}");
        System.out.println(sb.toString());
    }

    static void emitDiagnostic(String path, String message) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("{\"kind\":\"diagnostic\",")
          .append("\"filePath\":\"").append(escape(path)).append("\",")
          .append("\"message\":\"").append(escape(message)).append("\"}");
        System.out.println(sb.toString());
    }

    static String escape(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': out.append("\\\\"); break;
                case '"': out.append("\\\""); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }
}
