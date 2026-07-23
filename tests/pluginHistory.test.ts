import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import {
	PLUGIN_CAPABILITY_LOG,
	listPluginCapabilitiesNewestFirst,
} from "../src/domain/pluginChangelog";
import {
	recordRollbackIntent,
	syncPluginHistoryOnLoad,
} from "../src/services/pluginHistoryStore";

describe("plugin dual history", () => {
	it("capability log is non-empty and newest-first reverses", () => {
		expect(PLUGIN_CAPABILITY_LOG.length).toBeGreaterThan(3);
		const newest = listPluginCapabilitiesNewestFirst()[0]!;
		const oldest = PLUGIN_CAPABILITY_LOG[0]!;
		expect(newest.id).not.toBe(oldest.id);
		expect(newest.id).toBe(
			PLUGIN_CAPABILITY_LOG[PLUGIN_CAPABILITY_LOG.length - 1]!.id,
		);
	});

	it("syncPluginHistoryOnLoad records first seen and is immutable-safe", () => {
		const base = createDefaultSettings();
		expect(base.pluginHistory.lastSeenCapabilityId).toBeNull();
		const { settings, newCaps } = syncPluginHistoryOnLoad(base);
		expect(newCaps.length).toBe(PLUGIN_CAPABILITY_LOG.length);
		expect(settings.pluginHistory.lastSeenCapabilityId).toBe(
			PLUGIN_CAPABILITY_LOG[PLUGIN_CAPABILITY_LOG.length - 1]!.id,
		);
		// second sync: no new caps
		const again = syncPluginHistoryOnLoad(settings);
		expect(again.newCaps).toHaveLength(0);
	});

	it("recordRollbackIntent does not touch notebooks paths", () => {
		const base = createDefaultSettings();
		const next = recordRollbackIntent(base, "0.1.0", "cap-0.1.0-p0-p1");
		expect(next.pluginHistory.preferredPluginVersion).toBe("0.1.0");
		expect(next.pluginHistory.userNotes.some((n) => n.kind === "rollback-intent")).toBe(
			true,
		);
		expect(next.paths.notebooksRoot).toBe(base.paths.notebooksRoot);
	});
});
