package com.gaomu.suji.workshop.ui.recent

import com.gaomu.suji.workshop.net.RecentDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecentNavTest {
    private fun sampleGroups(): List<RecentNotebookGroup> {
        val rows =
            listOf(
                RecentDto(notebookId = "n1", notebookName = "空白本66", itemId = "i1", itemTitle = "qq", title = "a", at = "2"),
                RecentDto(notebookId = "n1", notebookName = "空白本66", itemId = "i2", itemTitle = "666", title = "b", at = "1"),
                RecentDto(notebookId = "n2", notebookName = "会议", itemId = "i9", itemTitle = "纪要", title = "d", at = "3"),
            )
        return groupRecentByNotebookAndItem(rows)
    }

    @Test
    fun popWalksRecordsToItemsToNotebooks() {
        val records = RecentNav.Records("n1", "i1")
        val items = records.popOrNull()
        assertTrue(items is RecentNav.Items)
        assertEquals("n1", (items as RecentNav.Items).notebookKey)
        assertEquals(RecentNav.Notebooks, items.popOrNull())
        assertNull(RecentNav.Notebooks.popOrNull())
    }

    @Test
    fun reconcileKeepsValidDrillDown() {
        val groups = sampleGroups()
        val nav = RecentNav.Records("n1", "i1")
        assertEquals(nav, nav.reconcileWith(groups))
    }

    @Test
    fun reconcileFallsBackWhenItemMissing() {
        val groups = sampleGroups()
        val nav = RecentNav.Records("n1", "missing-item")
        val next = nav.reconcileWith(groups)
        assertTrue(next is RecentNav.Items)
        assertEquals("n1", (next as RecentNav.Items).notebookKey)
    }

    @Test
    fun reconcileFallsBackWhenNotebookMissing() {
        val groups = sampleGroups()
        val nav = RecentNav.Items("gone")
        assertEquals(RecentNav.Notebooks, nav.reconcileWith(groups))
    }

    @Test
    fun notebookWriteCountSumsItemRows() {
        val groups = sampleGroups()
        val blank = groups.first { it.name == "空白本66" }
        assertEquals(2, notebookWriteCount(blank))
    }

    @Test
    fun formatRecentAtShortensIso() {
        assertEquals("08-07 09:28", formatRecentAt("2026-08-07T09:28:58.352Z"))
        assertEquals("—", formatRecentAt(""))
        assertEquals("custom", formatRecentAt("custom"))
    }
}
