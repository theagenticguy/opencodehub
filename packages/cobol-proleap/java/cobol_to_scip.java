/*
 * cobol_to_scip.java — tiny JVM wrapper over the uwol/cobol-parser library
 * (v4.0.0, package prefix io.proleap.cobol). Scaffolded in commit 1 with a
 * minimal "print classpath signal" main; commit 3 replaces the inner
 * walkProgram() body with the real ASG traversal.
 *
 * Protocol:
 *   - Reads one file path per line on stdin.
 *   - For each path, parses via CobolParserRunnerImpl.analyzeFile(...,
 *     CobolSourceFormatEnum.FIXED).
 *   - Emits one NDJSON record per discovered symbol def or ref on stdout.
 *     Record shape matches src/types.ts CobolDeepElement:
 *       { "kind": "program-id"|"paragraph"|"perform"|"copy"|"cics"
 *                |"data-item"|"file-descriptor",
 *         "name": string, "filePath": string,
 *         "startLine": int, "endLine": int }
 *   - On a single-file parse crash, emits a `"diagnostic"` record and
 *     continues to the next file so one bad file can't wedge the batch.
 *   - Exits 0 unless the JVM itself crashes (OOM, class-not-found, etc).
 *
 * NO external dependencies beyond the cobol-parser JAR and the JDK. Compile
 * against the JAR with:
 *   javac -cp /path/to/proleap-cobol-parser-4.0.0.jar cobol_to_scip.java
 */

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public class cobol_to_scip {

    public static void main(String[] args) throws Exception {
        // Verify the library classpath is present; if not, surface a clear
        // error rather than a generic ClassNotFoundException stack. We try to
        // load the top-level runner class name by reflection so the check
        // works even if the cobol-parser API package reshuffles between
        // maintenance releases.
        String runnerClass = "io.proleap.cobol.asg.runner.impl.CobolParserRunnerImpl";
        try {
            Class.forName(runnerClass);
        } catch (ClassNotFoundException e) {
            System.err.println(
                "cobol_to_scip: required class " + runnerClass
                    + " not on classpath. Expected the uwol/cobol-parser JAR "
                    + "(v4.0.0) on -cp. Re-run `codehub setup --cobol-proleap`.");
            System.exit(2);
        }

        try (BufferedReader in = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                String path = line.trim();
                if (path.isEmpty()) continue;
                try {
                    walkProgram(new File(path));
                } catch (Throwable t) {
                    // Per-file isolation: never let a single parse failure
                    // kill the batch. The TS wrapper treats the diagnostic
                    // record as a fallback-trigger for this path.
                    emitDiagnostic(path, t.getClass().getSimpleName() + ": " + t.getMessage());
                }
            }
        }
    }

    /**
     * Walk a single COBOL file and emit NDJSON records. Scaffolded here as a
     * minimal "proof the classpath works" probe — commit 3 replaces the body
     * with a real ASG traversal via
     * CobolParserRunnerImpl.analyzeFile(file, CobolSourceFormatEnum.FIXED).
     */
    static void walkProgram(File file) throws Exception {
        // Commit-1 scaffold: emit a single PROGRAM-ID stub record so downstream
        // wiring tests can exercise the bridge without needing the JAR. Commit
        // 3 tears this out and walks the ASG for real.
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        if (dot > 0) name = name.substring(0, dot);
        emitRecord("program-id", name, file.getPath(), 1, 1);
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
