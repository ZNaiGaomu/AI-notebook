package com.gaomu.suji.workshop.ui.recent

import com.gaomu.suji.workshop.net.RecentDto
import org.junit.Assert.assertEquals
import org.junit.Test

class RecentGroupingTest {
    @Test
    fun groupsByNotebookThenItemPreservingOrder() {
        val rows =
            listOf(
                RecentDto(notebookId = "n1", notebookName = "空白本66", itemId = "i1", itemTitle = "测试66", title = "a", at = "2"),
                RecentDto(notebookId = "n1", notebookName = "空白本66", itemId = "i2", itemTitle = "666", title = "b", at = "1"),
                RecentDto(notebookId = "n1", notebookName = "空白本66", itemId = "i1", itemTitle = "测试66", title = "c", at = "0"),
                RecentDto(notebookId = "n2", notebookName = "会议", itemId = "i9", itemTitle = "纪要", title = "d", at = "3"),
                RecentDto(title = "orphan", at = "4"),
            )
        val groups = groupRecentByNotebookAndItem(rows)
        assertEquals(3, groups.size)
        assertEquals("空白本66", groups[0].name)
        assertEquals(2, groups[0].items.size)
        assertEquals("测试66", groups[0].items[0].name)
        assertEquals(2, groups[0].items[0].rows.size)
        assertEquals("666", groups[0].items[1].name)
        assertEquals("会议", groups[1].name)
        assertEquals("未分类", groups[2].name)
    }
}
