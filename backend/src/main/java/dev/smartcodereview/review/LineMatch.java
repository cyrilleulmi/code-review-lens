package dev.smartcodereview.review;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Pairs equal lines of two versions of a line sequence, in order (a longest common subsequence). Small regions
 * are compared exactly; large ones are first split at lines that occur exactly once on both sides (patience
 * diff), so even whole files stay fast. Where neither works, lines stay unpaired: a missed pair only reopens a
 * line, a wrong pair would hide one.
 * <p>
 * Lines without content of their own ({@code }}, blank lines) are only paired as part of a run of consecutive
 * pairs that contains a real line, so a lone closing brace never carries a mark into other code.
 */
public final class LineMatch {

    /** Regions up to this many cells (lines a × lines b) are compared exactly. */
    static final int EXACT_LIMIT = 1_000_000;

    private LineMatch() {
    }

    /** result[i] = index in b of the line paired with a[i], or -1. Pairs are strictly increasing in both. */
    public static int[] match(List<String> a, List<String> b) {
        int[] result = new int[a.size()];
        Arrays.fill(result, -1);
        region(a, b, 0, a.size(), 0, b.size(), result);
        dropUnanchored(a, result);
        return result;
    }

    /** A line that says nothing on its own: no letter or digit, or at most two characters. */
    static boolean trivial(String line) {
        String t = line.strip();
        return t.length() <= 2 || t.chars().noneMatch(Character::isLetterOrDigit);
    }

    private static void region(List<String> a, List<String> b, int aLo, int aHi, int bLo, int bHi, int[] out) {
        while (aLo < aHi && bLo < bHi && a.get(aLo).equals(b.get(bLo))) {
            out[aLo++] = bLo++;
        }
        while (aLo < aHi && bLo < bHi && a.get(aHi - 1).equals(b.get(bHi - 1))) {
            out[--aHi] = --bHi;
        }
        if (aLo == aHi || bLo == bHi) {
            return;
        }
        if ((long) (aHi - aLo) * (bHi - bLo) <= EXACT_LIMIT) {
            exact(a, b, aLo, aHi, bLo, bHi, out);
            return;
        }
        List<int[]> anchors = uniqueAnchors(a, b, aLo, aHi, bLo, bHi);
        if (anchors.isEmpty()) {
            return; // too large and nothing to split at: leave unpaired
        }
        int pa = aLo, pb = bLo;
        for (int[] anchor : anchors) {
            region(a, b, pa, anchor[0], pb, anchor[1], out);
            out[anchor[0]] = anchor[1];
            pa = anchor[0] + 1;
            pb = anchor[1] + 1;
        }
        region(a, b, pa, aHi, pb, bHi, out);
    }

    /** Classic dynamic-programming LCS of the region. */
    private static void exact(List<String> a, List<String> b, int aLo, int aHi, int bLo, int bHi, int[] out) {
        int n = aHi - aLo, m = bHi - bLo;
        int[] len = new int[(n + 1) * (m + 1)]; // len[i][j] = LCS of a[i..] and b[j..]
        for (int i = n - 1; i >= 0; i--) {
            for (int j = m - 1; j >= 0; j--) {
                len[i * (m + 1) + j] = a.get(aLo + i).equals(b.get(bLo + j))
                        ? len[(i + 1) * (m + 1) + j + 1] + 1
                        : Math.max(len[(i + 1) * (m + 1) + j], len[i * (m + 1) + j + 1]);
            }
        }
        int i = 0, j = 0;
        while (i < n && j < m) {
            if (a.get(aLo + i).equals(b.get(bLo + j))) {
                out[aLo + i] = bLo + j;
                i++;
                j++;
            } else if (len[(i + 1) * (m + 1) + j] >= len[i * (m + 1) + j + 1]) {
                i++;
            } else {
                j++;
            }
        }
    }

    /** Lines occurring exactly once on each side, as pairs in the longest order-preserving chain. */
    private static List<int[]> uniqueAnchors(List<String> a, List<String> b, int aLo, int aHi, int bLo, int bHi) {
        Map<String, int[]> seen = new HashMap<>(); // line -> {count a, index a, count b, index b}
        for (int i = aLo; i < aHi; i++) {
            int[] s = seen.computeIfAbsent(a.get(i), k -> new int[4]);
            s[0]++;
            s[1] = i;
        }
        for (int j = bLo; j < bHi; j++) {
            int[] s = seen.get(b.get(j));
            if (s != null) {
                s[2]++;
                s[3] = j;
            }
        }
        List<int[]> pairs = new ArrayList<>();
        for (int i = aLo; i < aHi; i++) {
            int[] s = seen.get(a.get(i));
            if (s[0] == 1 && s[2] == 1) {
                pairs.add(new int[] {i, s[3]});
            }
        }
        return longestIncreasing(pairs);
    }

    /** Longest subsequence of pairs (sorted by a) that is increasing in b (patience sorting). */
    private static List<int[]> longestIncreasing(List<int[]> pairs) {
        int[] tails = new int[pairs.size()];
        int[] prev = new int[pairs.size()];
        int size = 0;
        for (int k = 0; k < pairs.size(); k++) {
            int lo = 0, hi = size;
            while (lo < hi) {
                int mid = (lo + hi) >>> 1;
                if (pairs.get(tails[mid])[1] < pairs.get(k)[1]) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            prev[k] = lo > 0 ? tails[lo - 1] : -1;
            tails[lo] = k;
            size = Math.max(size, lo + 1);
        }
        List<int[]> result = new ArrayList<>();
        for (int k = size > 0 ? tails[size - 1] : -1; k >= 0; k = prev[k]) {
            result.addFirst(pairs.get(k));
        }
        return result;
    }

    /** Unpairs runs of consecutive pairs that consist of trivial lines only. */
    private static void dropUnanchored(List<String> a, int[] out) {
        int i = 0;
        while (i < out.length) {
            if (out[i] < 0) {
                i++;
                continue;
            }
            int end = i + 1;
            while (end < out.length && out[end] == out[end - 1] + 1) {
                end++;
            }
            boolean anchored = false;
            for (int k = i; k < end && !anchored; k++) {
                anchored = !trivial(a.get(k));
            }
            if (!anchored) {
                Arrays.fill(out, i, end, -1);
            }
            i = end;
        }
    }
}
