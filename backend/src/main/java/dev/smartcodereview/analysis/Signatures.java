package dev.smartcodereview.analysis;

import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.Parameter;
import dev.smartcodereview.model.Model.Signature;
import dev.smartcodereview.model.Model.TypeField;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a function takes and gives back, and what a type consists of - read from the declarations with the same
 * simple means as the rest of the analysis (no parser, no type resolution): the parameter list between the
 * parentheses after the name, the return type where the language writes it, and the fields at the top level of a
 * type's body. For the detail levels of the diagrams (method names, signatures, data structures).
 *
 * Works on the "visible" copy of the source (comments blanked) for the texts and on the code-only copy for the
 * structure, so parentheses or commas in strings do not confuse it.
 */
public final class Signatures {

    /** Fields listed per type; the rest is counted (TypeInfo.more). */
    public static final int MAX_FIELDS = 12;
    /** How far below the start of a symbol (annotations, comments) its declaration is looked for. */
    private static final int MAX_HEAD_LINES = 40;
    private static final int MAX_DECLARATION = 300;

    /** What may stand between the name and its parameter list: nothing, or type parameters. */
    private static final Pattern DIRECT = Pattern.compile("^\\s*(?:<[^()]*>)?\\s*$");
    /** `name = (a) =>`, `name = async function (a)`, `name: Handler = (a) =>`, `val name = fun(a)`. */
    private static final Pattern ASSIGNED = Pattern.compile(
            "^\\s*(?::[^=()]*)?=\\s*(?:async\\s+)?(?:(?:function\\s*\\*?|fun)\\s*[\\w$]*\\s*)?(?:<[^()]*>\\s*)?$");
    /** `name: (a) =>`, `name: function (a)` - a function as a property. */
    private static final Pattern PROPERTY = Pattern.compile("^\\s*:\\s*(?:async\\s+)?(?:function\\s*\\*?\\s*)?$");

    private static final Pattern ANNOTATION = Pattern.compile("@[\\w.]+(?:\\([^()]*\\))?\\s*");
    private static final Pattern DECLARATION_MODIFIERS = Pattern.compile(
            "\\b(?:public|private|protected|internal|static|final|abstract|synchronized|default|native|strictfp|override"
                    + "|virtual|sealed|async|extern|unsafe|new|partial|readonly|export|declare|open|suspend|inline|operator"
                    + "|infix|tailrec|fun|function|func|get|set)\\b\\s*");
    private static final Pattern PARAMETER_MODIFIERS = Pattern.compile(
            "^(?:(?:public|private|protected|internal|readonly|override|final|vararg|val|var|noinline|crossinline|ref|out|in"
                    + "|params|this)\\s+)+");
    private static final Pattern TYPE_THEN_NAME = Pattern.compile("^(.*\\S)\\s+([A-Za-z_$][\\w$]*)$");
    /** A type name, qualified or not: of `Model.PrStatus` and `java.util.List` the last part counts. */
    private static final Pattern TYPE_NAME = Pattern.compile("(?<![\\w$.])(?:[\\w$]+\\.)*([A-Z][\\w$]*)(?![\\w$.])");

    /** Languages that write `name: Type` (the others write `Type name`, Go `name Type`). */
    private static final Set<String> NAME_FIRST = Set.of("typescript", "javascript", "kotlin", "python");

    private static final Pattern NAME_FIRST_FIELD = Pattern.compile(
            "^(?:(?:public|private|protected|readonly|static|declare|override|abstract|accessor)\\s+)*"
                    + "([A-Za-z_$][\\w$]*)(\\??)\\s*(?::\\s*(.+?))?\\s*(?:=\\s*.+?)?[;,]?$");
    private static final Pattern KOTLIN_FIELD = Pattern.compile(
            "^(?:(?:public|private|protected|internal|override|open|lateinit|const)\\s+)*(?:val|var)\\s+([A-Za-z_]\\w*)"
                    + "\\s*(?::\\s*([^=]+?))?\\s*(?:=.*)?$");
    private static final Pattern TYPE_FIRST_FIELD = Pattern.compile(
            "^(?:(?:public|private|protected|internal|static|final|volatile|transient|readonly|const|required)\\s+)*"
                    + "([\\w.$?]+(?:<[^;=(){}]*>)?(?:\\[\\])*\\??)\\s+([A-Za-z_$][\\w$]*)\\s*(?:=[^;]*;|;|\\{\\s*get\\b.*)$");
    private static final Pattern GO_FIELD = Pattern.compile("^([A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)*)\\s+([^`]+?)\\s*(?:`.*)?$");
    private static final Pattern ENUM_CONSTANT = Pattern.compile("^([A-Za-z_$][\\w$]*)\\s*(?:\\(.*\\))?\\s*(?:=\\s*[^,;]+)?[,;]?$");
    private static final Set<String> NOT_A_TYPE = Set.of("return", "throw", "new", "else", "case", "package", "import",
            "yield", "await", "delete", "typeof", "goto", "using", "namespace");

    private Signatures() {
    }

    /**
     * The signature of a function, method or component, or null when its declaration has no parameter list that can
     * be read (e.g. an arrow function with a bare parameter, `x => …`). types is left empty: the analyzer fills in
     * which of the named types it knows.
     */
    public static Signature of(CodeText text, Symbol symbol, String language) {
        String kind = symbol.kind();
        if (!kind.equals("function") && !kind.equals("method") && !kind.equals("component")) {
            return null;
        }
        Pattern name = Pattern.compile("(?<![\\w$.])" + Pattern.quote(symbol.name()) + "(?![\\w$])");
        int last = Math.min(symbol.endLine(), symbol.startLine() + MAX_HEAD_LINES);
        for (int li = symbol.startLine() - 1; li < last && li < text.code.size(); li++) {
            String code = text.code.get(li);
            Matcher m = name.matcher(code);
            while (m.find()) {
                int open = code.indexOf('(', m.end());
                if (open < 0) {
                    continue;
                }
                String between = code.substring(m.end(), open);
                if (!DIRECT.matcher(between).matches() && !ASSIGNED.matcher(between).matches() && !PROPERTY.matcher(between).matches()) {
                    continue;
                }
                int[] end = text.skipParens(li, open);
                if (end == null) {
                    return null;
                }
                List<Parameter> params = parameters(between(text, li, open + 1, end[0], end[1] - 1), language);
                // what follows the parameter list up to the body: the return type, where the language writes it there
                String tail = tail(text, end, language);
                String returns = language.equals("go") ? emptyToNull(tail)
                        : NAME_FIRST.contains(language) ? (tail.startsWith(":") ? emptyToNull(tail.substring(1).strip()) : null)
                        : returnsBefore(text.visible.get(li).substring(0, m.start()));
                String declaration = collapse(between(text, li, firstCode(code), end[0], end[1]))
                        + (tail.isEmpty() ? "" : tail.startsWith(":") ? tail : " " + tail);
                if (declaration.length() > MAX_DECLARATION) {
                    declaration = declaration.substring(0, MAX_DECLARATION) + "…";
                }
                return new Signature(declaration, params, returns, List.of());
            }
        }
        return null;
    }

    /**
     * The names of types in a signature (capitalised identifiers of the parameter and return types), in order; of a
     * qualified name (`Model.PrStatus`, `context.Context`) the type itself.
     */
    public static List<String> typeNames(Signature signature) {
        Set<String> names = new LinkedHashSet<>();
        List<String> texts = new ArrayList<>();
        signature.params().forEach(p -> texts.add(p.type()));
        texts.add(signature.returns());
        for (String t : texts) {
            if (t != null) {
                Matcher m = TYPE_NAME.matcher(t);
                while (m.find()) {
                    names.add(m.group(1));
                }
            }
        }
        return List.copyOf(names);
    }

    /**
     * The fields of a class, interface, type or enum, in the order of the code: what stands at the top level of its
     * body as a field or property, the components of a record or the constructor properties of a Kotlin class, the
     * constants of an enum (type null). Methods are left out. All of them, the caller cuts at {@link #MAX_FIELDS}.
     */
    public static List<TypeField> fieldsOf(CodeText text, Symbol type, String language) {
        List<TypeField> fields = new ArrayList<>();
        // the declaration: the first line that names the type (annotations above it may hold braces of their own)
        Pattern named = Pattern.compile("(?<![\\w$.@])" + Pattern.quote(type.name()) + "(?![\\w$])");
        int first = type.startLine() - 1;
        int col = 0;
        for (int li = first; li < type.endLine() && li < text.code.size(); li++) {
            Matcher m = named.matcher(text.code.get(li));
            if (m.find()) {
                first = li;
                col = m.start();
                break;
            }
        }
        CodeText.BracePair body = text.firstPairFrom(first, col, MAX_HEAD_LINES);
        if (body != null && body.openLine() >= type.endLine()) {
            body = null;
        }
        // record Player(String name, int number) / data class Player(val name: String): the fields are in the head
        Pattern name = Pattern.compile("(?<![\\w$.])" + Pattern.quote(type.name()) + "(?![\\w$])\\s*(?:<[^()]*>)?\\s*\\(");
        int headEnd = body == null ? Math.min(type.endLine(), first + 3) : body.openLine() + 1;
        for (int li = first; li < headEnd && li < text.code.size() && !language.equals("go"); li++) {
            String code = text.code.get(li);
            Matcher m = name.matcher(code);
            if (m.find() && (body == null || li < body.openLine() || m.end() <= body.openCol())) {
                int[] end = text.skipParens(li, m.end() - 1);
                if (end != null) {
                    parameters(between(text, li, m.end(), end[0], end[1] - 1), language)
                            .forEach(p -> fields.add(new TypeField(p.name(), p.type())));
                }
                break;
            }
        }
        if (body == null) {
            return fields;
        }
        boolean isEnum = type.kind().equals("enum");
        int depth = 0;
        for (int li = body.openLine(); li <= body.closeLine() && li < text.code.size(); li++) {
            String code = text.code.get(li);
            int from = li == body.openLine() ? body.openCol() + 1 : 0;
            int depthAtStart = depth;
            for (int i = from; i < code.length(); i++) {
                char c = code.charAt(i);
                if (c == '{' || c == '(' || c == '[') {
                    depth++;
                } else if (c == '}' || c == ')' || c == ']') {
                    depth--;
                }
            }
            if (li == body.openLine() || depthAtStart != 0 || depth < 0) {
                continue; // the line of the opening brace, inside a member, or the closing brace
            }
            String line = ANNOTATION.matcher(text.visible.get(li).strip()).replaceAll("").strip();
            if (line.isEmpty()) {
                continue;
            }
            if (isEnum) {
                Matcher m = ENUM_CONSTANT.matcher(line);
                if (!m.matches()) {
                    break; // after the constants: fields and methods of the enum
                }
                fields.add(new TypeField(m.group(1), null));
                if (line.endsWith(";")) {
                    break;
                }
                continue;
            }
            TypeField field = field(line, language, depth > depthAtStart);
            if (field != null) {
                fields.add(field);
            }
        }
        return fields;
    }

    /** opens: the line opens a block that it does not close (a method, a nested object type). */
    private static TypeField field(String line, String language, boolean opens) {
        if (language.equals("go")) {
            Matcher m = GO_FIELD.matcher(line);
            return m.matches() && !opens ? new TypeField(m.group(1), collapse(m.group(2))) : null;
        }
        if (language.equals("kotlin")) {
            Matcher m = KOTLIN_FIELD.matcher(line);
            return m.matches() ? new TypeField(m.group(1), m.group(2) == null ? null : collapse(m.group(2))) : null;
        }
        if (NAME_FIRST.contains(language)) {
            Matcher m = NAME_FIRST_FIELD.matcher(opens ? line.replaceFirst("\\{\\s*$", "{…}") : line);
            if (!m.matches() || (m.group(3) == null && !line.contains("=")) || NOT_A_TYPE.contains(m.group(1))) {
                return null; // neither `name: Type` nor `name = value`
            }
            return new TypeField(m.group(1) + m.group(2), m.group(3) == null ? null : collapse(m.group(3)));
        }
        Matcher m = TYPE_FIRST_FIELD.matcher(line);
        return m.matches() && !NOT_A_TYPE.contains(m.group(1)) ? new TypeField(m.group(2), collapse(m.group(1))) : null;
    }

    // ------------------------------------------------------------------ parameters and return type

    /** The parameters in a parameter list (the text between its parentheses). */
    static List<Parameter> parameters(String list, String language) {
        List<Parameter> params = new ArrayList<>();
        List<String> pending = new ArrayList<>(); // Go: `a, b int` - names waiting for their type
        for (String raw : splitTopLevel(list)) {
            String part = collapse(ANNOTATION.matcher(raw).replaceAll(""));
            if (part.isEmpty()) {
                continue;
            }
            if (language.equals("go")) {
                int space = part.indexOf(' ');
                if (space < 0) {
                    pending.add(part);
                    continue;
                }
                String type = part.substring(space + 1).strip();
                pending.forEach(n -> params.add(new Parameter(n, type)));
                pending.clear();
                params.add(new Parameter(part.substring(0, space), type));
                continue;
            }
            part = PARAMETER_MODIFIERS.matcher(part).replaceFirst("");
            int assign = topLevel(part, '=');
            if (assign >= 0 && (assign + 1 >= part.length() || part.charAt(assign + 1) != '>')) {
                part = part.substring(0, assign).strip(); // default value
            }
            if (NAME_FIRST.contains(language)) {
                int colon = topLevel(part, ':');
                String name = (colon < 0 ? part : part.substring(0, colon)).strip();
                name = name.startsWith("{") ? "{…}" : name.startsWith("[") ? "[…]" : name;
                params.add(new Parameter(name, colon < 0 ? null : emptyToNull(part.substring(colon + 1).strip())));
            } else {
                Matcher m = TYPE_THEN_NAME.matcher(part);
                params.add(m.matches() ? new Parameter(m.group(2), m.group(1)) : new Parameter(part, null));
            }
        }
        // Go: only types, no names (`func(int, string)`)
        pending.forEach(type -> params.add(new Parameter("", type)));
        return params;
    }

    /**
     * What stands between the parameter list and the body: `: Type` (TypeScript, Kotlin - up to `{`, `=>` or `=`),
     * `Type` / `(Type, error)` (Go), `throws X` (Java); "" when there is nothing.
     */
    private static String tail(CodeText text, int[] end, String language) {
        int[] stop = new int[2];
        text.textUntil(end[0], end[1], language.equals("go") ? "{" : NAME_FIRST.contains(language) ? "{=;" : "{;", 3, stop);
        if (stop[0] < 0) {
            stop[0] = end[0];
            stop[1] = text.visible.get(end[0]).length();
        }
        return collapse(between(text, end[0], end[1], stop[0], stop[1]));
    }

    /** `public static <T> List<T> name(` (Java, C#): what is left before the name without annotations and modifiers. */
    private static String returnsBefore(String beforeName) {
        String s = ANNOTATION.matcher(beforeName).replaceAll(" ");
        s = DECLARATION_MODIFIERS.matcher(s).replaceAll("").strip();
        if (s.startsWith("<")) { // type parameters of the method
            int depth = 0;
            for (int i = 0; i < s.length(); i++) {
                depth += s.charAt(i) == '<' ? 1 : s.charAt(i) == '>' ? -1 : 0;
                if (depth == 0) {
                    s = s.substring(i + 1).strip();
                    break;
                }
            }
        }
        return emptyToNull(collapse(s));
    }

    // ------------------------------------------------------------------ text helpers

    /** The visible text from (line, col) up to but excluding (endLine, endCol), lines joined by a space. */
    private static String between(CodeText text, int line, int col, int endLine, int endCol) {
        StringBuilder sb = new StringBuilder();
        for (int li = line; li <= endLine && li < text.visible.size(); li++) {
            String s = text.visible.get(li);
            int from = li == line ? Math.min(col, s.length()) : 0;
            int to = li == endLine ? Math.min(Math.max(endCol, from), s.length()) : s.length();
            sb.append(s, from, to);
            if (li < endLine) {
                sb.append(' ');
            }
        }
        return sb.toString();
    }

    /** Splits at the commas that are not inside (), [], {} or <>. */
    private static List<String> splitTopLevel(String list) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        int start = 0;
        for (int i = 0; i < list.length(); i++) {
            char c = list.charAt(i);
            if (c == '(' || c == '[' || c == '{' || c == '<') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}' || (c == '>' && (i == 0 || list.charAt(i - 1) != '='))) {
                depth--;
            } else if (c == ',' && depth <= 0) {
                parts.add(list.substring(start, i));
                start = i + 1;
            }
        }
        parts.add(list.substring(start));
        return parts;
    }

    /** Index of the first `c` outside (), [], {} and <>; -1 if there is none. */
    private static int topLevel(String s, char c) {
        int depth = 0;
        for (int i = 0; i < s.length(); i++) {
            char x = s.charAt(i);
            if (x == c && depth <= 0) {
                return i;
            }
            if (x == '(' || x == '[' || x == '{' || x == '<') {
                depth++;
            } else if (x == ')' || x == ']' || x == '}' || (x == '>' && (i == 0 || s.charAt(i - 1) != '='))) {
                depth--;
            }
        }
        return -1;
    }

    private static int firstCode(String code) {
        int i = 0;
        while (i < code.length() && Character.isWhitespace(code.charAt(i))) {
            i++;
        }
        return i;
    }

    private static String collapse(String s) {
        return s.replaceAll("\\s+", " ").strip();
    }

    private static String emptyToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }
}
