package dev.smartcodereview.analysis;

import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.DiffLine;
import dev.smartcodereview.model.Model.ExpectationChange;
import dev.smartcodereview.model.Model.Hunk;
import dev.smartcodereview.model.Model.SpecEntry;
import dev.smartcodereview.model.Model.SpecFile;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Spec-Diff: the test names of a changed test file as an outline (suite › suite › test), old version against new
 * version. Deterministic, no AI:
 * <ol>
 *   <li>Suites and tests come from {@link SymbolExtractor} (kinds suite / test); a class that contains a test acts
 *       as a suite (JUnit: the test class and its @Nested classes). Nesting = range containment.</li>
 *   <li>Old and new entries are matched by their full path (kind + suite chain + name); duplicates pair up in
 *       file order. Matched entries are "changed" when a changed line of the PR diff (not blank, not only braces)
 *       lies inside them on either side, else "unchanged".</li>
 *   <li>Unmatched entries of the same kind whose text is identical apart from whitespace and the name itself are a
 *       rename: suites first (in old order; the old paths below a renamed suite are rewritten to the new name and
 *       matched again), then tests. Each removed entry takes the first free added entry in new file order.</li>
 *   <li>The rest is "added" (only new) or "removed" (only old).</li>
 * </ol>
 * Order: new file order; a removed entry goes after its previous sibling of the old file (and that sibling's
 * children), else first in its suite, else to the top.
 * <p>
 * Each matched entry also carries its changed expectations (assertions old against new, switched off / on; see
 * {@link Expectations}), each test its number of assertions on both sides.
 */
public final class Specs {

    public static final String ADDED = "added";
    public static final String REMOVED = "removed";
    public static final String CHANGED = "changed";
    public static final String RENAMED = "renamed";
    public static final String UNCHANGED = "unchanged";

    /** The segment id of a changed symbol of a file (new version), null if the symbol has no segment. */
    @FunctionalInterface
    public interface SegmentLookup {
        String segmentOf(String path, Symbol symbol);
    }

    private Specs() {
    }

    /** A changed test file whose old version is needed for the outline (everything but new files). */
    public static boolean needsBase(Rules rules, DiffFile f) {
        return isTestFile(rules, f) && !ADDED.equals(f.status());
    }

    /** Test files (path rule of category tests) in a language with symbols, with a patch. */
    public static boolean isTestFile(Rules rules, DiffFile f) {
        Rules.Rule r = rules.forPath(f.path());
        return r != null && "tests".equals(r.category()) && Languages.hasSymbols(f.language()) && !f.patchMissing();
    }

    /** Path of the file in the base version: the old path of a renamed file, else its path. */
    public static String basePath(DiffFile f) {
        return f.previousPath() != null && !f.previousPath().isBlank() ? f.previousPath() : f.path();
    }

    private static final class Node {
        final String name;
        final String kind;
        final Symbol symbol;
        /** text without whitespace and with the name blanked out, to recognise renames */
        final String body;
        List<String> suites;
        Node parent;
        boolean changed;
        Node partner;
        boolean renamed;
        String previousName;
        final CodeText text;
        /** the line that switches this entry off (its own or an enclosing suite's), 0 = active */
        int disabledLine;
        /** assertion statements of a test (null for suites) */
        List<Expectations.Assertion> assertions;

        Node(Symbol symbol, String body, List<String> suites, CodeText text) {
            this.name = symbol.name();
            this.kind = "test".equals(symbol.kind()) ? "test" : "suite";
            this.symbol = symbol;
            this.body = body;
            this.suites = suites;
            this.text = text;
        }

        String key() {
            return kind + "\u0000" + String.join("\u0000", suites) + "\u0000" + name;
        }

        List<String> path() {
            List<String> p = new ArrayList<>(suites);
            p.add(name);
            return p;
        }
    }

    /**
     * The outline of one changed test file. source: new version (null for removed files); base: old version (null
     * for added files or when it could not be loaded). Returns null when there is nothing to show.
     */
    public static SpecFile of(DiffFile file, String source, String base, SegmentLookup segments,
                              Expectations expectations) {
        boolean removedFile = REMOVED.equals(file.status());
        boolean baseNeeded = !ADDED.equals(file.status());
        boolean baseAvailable = !baseNeeded || base != null;
        if (!removedFile && source == null) {
            return null; // new version not loaded: nothing to anchor the outline on
        }
        List<Node> news = removedFile ? List.of() : extract(source, file.path(), expectations);
        List<Node> olds = base == null ? List.of() : extract(base, basePath(file), expectations);
        if (news.isEmpty() && olds.isEmpty() && baseAvailable) {
            return null; // a test helper or fixture without test cases
        }

        Set<Integer> addedLines = new HashSet<>();
        Set<Integer> changedNew = new HashSet<>();
        Set<Integer> changedOld = new HashSet<>();
        Set<Integer> deletionAnchors = new HashSet<>();
        for (Hunk h : file.hunks()) {
            for (DiffLine l : h.lines()) {
                boolean relevant = !Rules.isTrivial(l.text());
                if ("add".equals(l.type())) {
                    addedLines.add(l.newLine());
                    if (relevant) {
                        changedNew.add(l.newLine());
                    }
                } else if ("del".equals(l.type()) && relevant) {
                    changedOld.add(l.oldLine());
                    deletionAnchors.add(FileView.anchorOf(l, h));
                }
            }
        }
        news.forEach(n -> n.changed = touches(n.symbol, changedNew));
        olds.forEach(o -> o.changed = touches(o.symbol, changedOld));

        if (baseAvailable) {
            match(olds, news);
        }

        List<Item> items = new ArrayList<>();
        Map<Node, Item> itemOf = new HashMap<>();
        CodeText newText = news.isEmpty() ? null : news.getFirst().text;
        for (Node n : news) {
            String status;
            if (n.partner != null) {
                status = n.renamed ? RENAMED : n.changed || n.partner.changed ? CHANGED : UNCHANGED;
            } else if (baseAvailable) {
                status = ADDED;
            } else {
                status = onlyAdded(n.symbol, newText, addedLines) ? ADDED
                        : n.changed || hasDeletion(n.symbol, deletionAnchors) ? CHANGED : UNCHANGED;
            }
            Node o = n.partner;
            Item item = new Item(new SpecEntry(n.name, List.copyOf(n.suites), n.kind, status, n.previousName,
                    segments.segmentOf(file.path(), n.symbol), n.symbol.startLine(),
                    o == null ? null : o.symbol.startLine(), n.suites.size(),
                    o == null ? List.of() : expectationChanges(o, n, expectations),
                    o == null || o.assertions == null ? null : o.assertions.size(),
                    n.assertions == null ? null : n.assertions.size(),
                    n.disabledLine > 0));
            items.add(item);
            itemOf.put(n, item);
            if (n.partner != null) {
                itemOf.put(n.partner, item);
            }
        }
        for (int i = 0; i < olds.size(); i++) {
            Node o = olds.get(i);
            if (o.partner == null) {
                insertRemoved(o, olds.subList(0, i), items, itemOf);
            }
        }
        return new SpecFile(file.path(), file.previousPath(), file.status(), baseAvailable,
                items.stream().map(Item::entry).toList());
    }

    /** A place in the outline (identity matters: two entries may look alike). */
    private static final class Item {
        final SpecEntry entry;

        Item(SpecEntry entry) {
            this.entry = entry;
        }

        SpecEntry entry() {
            return entry;
        }

        int depth() {
            return entry.depth();
        }
    }

    /**
     * A removed entry goes after its previous sibling in the old file (behind that sibling's children), else right
     * after its suite (as first child), else to the top.
     */
    private static void insertRemoved(Node o, List<Node> before, List<Item> items, Map<Node, Item> itemOf) {
        Node sibling = null;
        for (int j = before.size() - 1; j >= 0; j--) {
            if (before.get(j).parent == o.parent) {
                sibling = before.get(j);
                break;
            }
        }
        int index;
        int depth;
        Item anchor = sibling != null ? itemOf.get(sibling) : o.parent != null ? itemOf.get(o.parent) : null;
        if (anchor == null) {
            index = 0;
            depth = 0;
        } else if (sibling != null) {
            depth = anchor.depth();
            index = items.indexOf(anchor) + 1;
            while (index < items.size() && items.get(index).depth() > depth) {
                index++;
            }
        } else {
            depth = anchor.depth() + 1;
            index = items.indexOf(anchor) + 1;
        }
        // a removed test takes its assertions with it: only their number, not each one
        Item item = new Item(new SpecEntry(o.name, List.copyOf(o.suites), o.kind, REMOVED, null, null, null,
                o.symbol.startLine(), depth, List.of(), o.assertions == null ? null : o.assertions.size(), null, false));
        items.add(index, item);
        itemOf.put(o, item);
    }

    /** Path matching, then renamed suites (re-matching below them), then renamed tests. */
    private static void match(List<Node> olds, List<Node> news) {
        matchByPath(olds, news);
        for (Node o : olds) {
            if (o.partner != null || !"suite".equals(o.kind)) {
                continue;
            }
            Node n = sameBody(o, news);
            if (n != null) {
                List<String> from = o.path();
                List<String> to = n.path();
                pairRenamed(o, n);
                for (Node d : olds) {
                    if (d.suites.size() >= from.size() && d.suites.subList(0, from.size()).equals(from)) {
                        List<String> moved = new ArrayList<>(to);
                        moved.addAll(d.suites.subList(from.size(), d.suites.size()));
                        d.suites = moved;
                    }
                }
                matchByPath(olds, news);
            }
        }
        for (Node o : olds) {
            if (o.partner == null && "test".equals(o.kind)) {
                Node n = sameBody(o, news);
                if (n != null) {
                    pairRenamed(o, n);
                }
            }
        }
    }

    private static void matchByPath(List<Node> olds, List<Node> news) {
        Map<String, Deque<Node>> free = new LinkedHashMap<>();
        for (Node n : news) {
            if (n.partner == null) {
                free.computeIfAbsent(n.key(), k -> new ArrayDeque<>()).add(n);
            }
        }
        for (Node o : olds) {
            Deque<Node> q = o.partner == null ? free.get(o.key()) : null;
            if (q != null && !q.isEmpty()) {
                Node n = q.poll();
                o.partner = n;
                n.partner = o;
            }
        }
    }

    private static Node sameBody(Node o, List<Node> news) {
        return news.stream().filter(n -> n.partner == null && n.kind.equals(o.kind) && n.body.equals(o.body))
                .findFirst().orElse(null);
    }

    private static void pairRenamed(Node o, Node n) {
        o.partner = n;
        n.partner = o;
        n.renamed = true;
        n.previousName = o.suites.equals(n.suites) ? o.name : String.join(" › ", o.path());
    }

    /**
     * Changed expectations of a matched entry: switched off / on (the test itself or an enclosing suite), and for
     * tests the assertion statements old against new (see {@link Expectations}).
     */
    private static List<ExpectationChange> expectationChanges(Node o, Node n, Expectations expectations) {
        List<ExpectationChange> result = new ArrayList<>();
        if (n.disabledLine > 0 && o.disabledLine == 0) {
            result.add(new ExpectationChange(Expectations.DISABLED, null,
                    Expectations.lineText(n.text, n.disabledLine), null, n.disabledLine));
        } else if (n.disabledLine == 0 && o.disabledLine > 0) {
            result.add(new ExpectationChange(Expectations.ENABLED, Expectations.lineText(o.text, o.disabledLine), null,
                    o.disabledLine, null));
        }
        if (o.assertions != null && n.assertions != null) {
            result.addAll(expectations.compare(o.assertions, n.assertions));
        }
        return result;
    }

    /** Suites and tests of a source, in file order (outer before inner), with their assertions and disabled state. */
    private static List<Node> extract(String source, String path, Expectations expectations) {
        CodeText text = CodeText.of(source);
        List<Symbol> symbols = SymbolExtractor.extract(text, path);
        List<Symbol> tests = symbols.stream().filter(s -> "test".equals(s.kind())).toList();
        List<Symbol> suites = symbols.stream()
                .filter(s -> "suite".equals(s.kind()) || ("class".equals(s.kind())
                        && tests.stream().anyMatch(t -> encloses(s, t))))
                .toList();
        List<Symbol> all = new ArrayList<>(suites);
        all.addAll(tests);
        all.sort(OUTER_FIRST);
        List<Node> nodes = new ArrayList<>();
        Map<Symbol, Node> bySymbol = new HashMap<>();
        for (Symbol s : all) {
            List<Symbol> chain = suites.stream().filter(c -> c != s && encloses(c, s)).sorted(OUTER_FIRST).toList();
            Node n = new Node(s, body(text, s), new ArrayList<>(chain.stream().map(Symbol::name).toList()), text);
            n.parent = chain.isEmpty() ? null : bySymbol.get(chain.getLast());
            boolean test = "test".equals(n.kind);
            int own = expectations.disabledLine(text, s, test);
            n.disabledLine = own > 0 || n.parent == null ? own : n.parent.disabledLine;
            n.assertions = test ? expectations.assertions(text, s) : null;
            bySymbol.put(s, n);
            nodes.add(n);
        }
        return nodes;
    }

    private static final Comparator<Symbol> OUTER_FIRST = Comparator.comparingInt(Symbol::startLine)
            .thenComparing(Comparator.comparingInt(Symbol::endLine).reversed());

    private static boolean encloses(Symbol outer, Symbol inner) {
        return outer != inner && outer.startLine() <= inner.startLine() && outer.endLine() >= inner.endLine()
                && outer.span() > inner.span();
    }

    /** The whole text of the symbol without whitespace, with its own name blanked out (first occurrence). */
    private static String body(CodeText text, Symbol s) {
        String raw = String.join("\n", text.lines.subList(s.startLine() - 1, Math.min(s.endLine(), text.lines.size())));
        int at = s.name().isEmpty() ? -1 : raw.indexOf(s.name());
        if (at >= 0) {
            raw = raw.substring(0, at) + "\u0000" + raw.substring(at + s.name().length());
        }
        return raw.replaceAll("\\s+", "");
    }

    private static boolean touches(Symbol s, Set<Integer> lines) {
        for (int line = s.startLine(); line <= s.endLine(); line++) {
            if (lines.contains(line)) {
                return true;
            }
        }
        return false;
    }

    /** Without base: every line of the entry that is not blank or only braces is an added line. */
    private static boolean onlyAdded(Symbol s, CodeText text, Set<Integer> addedLines) {
        for (int line = s.startLine(); line <= Math.min(s.endLine(), text.lines.size()); line++) {
            if (!Rules.isTrivial(text.lines.get(line - 1)) && !addedLines.contains(line)) {
                return false;
            }
        }
        return true;
    }

    /** Without base: a deleted line sits inside the entry (between two of its lines). */
    private static boolean hasDeletion(Symbol s, Set<Integer> anchors) {
        return anchors.stream().anyMatch(a -> a > s.startLine() && a <= s.endLine());
    }
}
