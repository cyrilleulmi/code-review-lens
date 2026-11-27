package dev.codereviewlens.analysis.category;

import dev.codereviewlens.model.Model.Flow;
import dev.codereviewlens.model.Model.FlowStep;
import dev.codereviewlens.model.Model.Group;

import java.util.ArrayList;
import java.util.List;

/** Data flows: one group per flow (entry point and everything it reaches). Exception: has its own UI (view "flow"). */
public final class FlowCategory implements CategoryModule {

    public static final String ID = "flows";

    private final CategoryInfo info;

    public FlowCategory(CategoryInfo info) {
        this.info = info;
    }

    @Override
    public String id() {
        return ID;
    }

    @Override
    public CategoryInfo info() {
        return info;
    }

    @Override
    public String view() {
        return VIEW_FLOW;
    }

    @Override
    public String origin() {
        return ORIGIN_BUILTIN;
    }

    @Override
    public List<Group> groups(CategoryContext ctx) {
        List<Group> groups = new ArrayList<>();
        for (Flow f : ctx.flows()) {
            groups.add(new Group(ID + "/" + f.id(), f.title(), f.steps().size() + " Schritte", f.id(),
                    f.steps().stream().map(FlowStep::segmentId).toList()));
        }
        return groups;
    }
}
