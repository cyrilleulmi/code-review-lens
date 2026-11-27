package dev.codereviewlens.analysis.category;

import dev.codereviewlens.model.Model.Flow;

import java.util.List;

/**
 * Everything a module gets to build its groups from. groupOrder: the order of rule groups in the rule file, so
 * groups of one category appear in a stable, meaningful order.
 */
public record CategoryContext(List<SegmentFacts> segments, List<Flow> flows, List<String> groupOrder) {
}
