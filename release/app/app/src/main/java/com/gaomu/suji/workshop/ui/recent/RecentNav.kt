package com.gaomu.suji.workshop.ui.recent

/**
 * Three-level navigation for the Recent tab:
 * L1 notebooks → L2 items in a notebook → L3 write history of an item.
 */
sealed class RecentNav {
    data object Notebooks : RecentNav()

    data class Items(
        val notebookKey: String,
    ) : RecentNav()

    data class Records(
        val notebookKey: String,
        val itemKey: String,
    ) : RecentNav()
}

/** Pop one level; null means already at root (caller should not consume back). */
fun RecentNav.popOrNull(): RecentNav? =
    when (this) {
        is RecentNav.Notebooks -> null
        is RecentNav.Items -> RecentNav.Notebooks
        is RecentNav.Records -> RecentNav.Items(notebookKey)
    }

/**
 * After a refresh, keep the current drill-down only if the keys still exist;
 * otherwise fall back to the nearest valid ancestor (or L1).
 */
fun RecentNav.reconcileWith(groups: List<RecentNotebookGroup>): RecentNav =
    when (this) {
        is RecentNav.Notebooks -> this
        is RecentNav.Items -> {
            if (groups.any { it.key == notebookKey }) this else RecentNav.Notebooks
        }
        is RecentNav.Records -> {
            val nb = groups.firstOrNull { it.key == notebookKey }
            when {
                nb == null -> RecentNav.Notebooks
                nb.items.any { it.key == itemKey } -> this
                else -> RecentNav.Items(notebookKey)
            }
        }
    }

fun findNotebook(
    groups: List<RecentNotebookGroup>,
    notebookKey: String,
): RecentNotebookGroup? = groups.firstOrNull { it.key == notebookKey }

fun findItem(
    groups: List<RecentNotebookGroup>,
    notebookKey: String,
    itemKey: String,
): RecentItemGroup? = findNotebook(groups, notebookKey)?.items?.firstOrNull { it.key == itemKey }

fun notebookWriteCount(group: RecentNotebookGroup): Int = group.items.sumOf { it.rows.size }
