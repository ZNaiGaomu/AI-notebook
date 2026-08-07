package com.gaomu.suji.workshop.ui.recent

import com.gaomu.suji.workshop.net.RecentDto

data class RecentItemGroup(
    val key: String,
    val name: String,
    val rows: List<RecentDto>,
)

data class RecentNotebookGroup(
    val key: String,
    val name: String,
    val items: List<RecentItemGroup>,
)

/**
 * Group recent rows as 记录本 → 条目 → 写入记录.
 * Missing notebook/item metadata falls into 未分类 / 未命名条目.
 */
fun groupRecentByNotebookAndItem(rows: List<RecentDto>): List<RecentNotebookGroup> {
    if (rows.isEmpty()) return emptyList()
    val notebookOrder = linkedMapOf<String, MutableList<RecentDto>>()
    for (row in rows) {
        val nbKey =
            row.notebookId.takeIf { it.isNotBlank() }
                ?: row.notebookName.takeIf { it.isNotBlank() }
                ?: "_unknown"
        notebookOrder.getOrPut(nbKey) { mutableListOf() }.add(row)
    }
    return notebookOrder.map { (nbKey, nbRows) ->
        val nbName =
            nbRows.firstOrNull { it.notebookName.isNotBlank() }?.notebookName
                ?: if (nbKey == "_unknown") "未分类" else "记录本"
        val itemOrder = linkedMapOf<String, MutableList<RecentDto>>()
        for (row in nbRows) {
            val itKey =
                row.itemId.takeIf { it.isNotBlank() }
                    ?: row.itemTitle.takeIf { it.isNotBlank() }
                    ?: row.path.takeIf { it.isNotBlank() }
                    ?: row.title.takeIf { it.isNotBlank() }
                    ?: "_item"
            itemOrder.getOrPut(itKey) { mutableListOf() }.add(row)
        }
        val items =
            itemOrder.map { (itKey, itRows) ->
                val itName =
                    itRows.firstOrNull { it.itemTitle.isNotBlank() }?.itemTitle
                        ?: itRows.firstOrNull { it.title.isNotBlank() }?.title
                        ?: "未命名条目"
                RecentItemGroup(key = itKey, name = itName, rows = itRows)
            }
        RecentNotebookGroup(key = nbKey, name = nbName, items = items)
    }
}
