package com.gaomu.suji.workshop.ui.recent

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gaomu.suji.workshop.data.repo.LocalRecentEntry
import com.gaomu.suji.workshop.data.repo.matchLocalRecentEntry
import com.gaomu.suji.workshop.net.RecentDto
import com.gaomu.suji.workshop.ui.SujiViewModel
import com.gaomu.suji.workshop.ui.theme.Accent
import com.gaomu.suji.workshop.ui.theme.Card
import com.gaomu.suji.workshop.ui.theme.Danger
import com.gaomu.suji.workshop.ui.theme.Muted
import com.gaomu.suji.workshop.ui.theme.TextPrimary

@Composable
fun RecentScreen(vm: SujiViewModel) {
    val state by vm.ui.collectAsState()
    LaunchedEffect(state.connected) { if (state.connected) vm.loadRecent() }

    var nav by remember { mutableStateOf<RecentNav>(RecentNav.Notebooks) }
    var sourceRow by remember { mutableStateOf<RecentDto?>(null) }
    var deleteTarget by remember { mutableStateOf<DeleteTarget?>(null) }
    val clipboard = LocalClipboardManager.current

    val rows =
        state.recent.filterNot { row ->
            val key =
                row.clientSourceId.takeIf { it.isNotBlank() }?.let { "client:$it" }
                    ?: row.path.takeIf { it.isNotBlank() }?.let { "path:${row.kind}:$it" }
            key != null && key in state.hiddenRecentKeys
        }
    val groups = remember(rows) { groupRecentByNotebookAndItem(rows) }

    LaunchedEffect(groups) {
        nav = nav.reconcileWith(groups)
    }

    val keyOf: (RecentDto) -> String = { row ->
        row.clientSourceId.ifBlank { "${row.kind}|${row.path}|${row.at}|${row.title}" }
    }
    val localFor: (RecentDto) -> LocalRecentEntry? = { row ->
        val what = row.sourceLabel.ifBlank { row.preview.ifBlank { row.title } }
        matchLocalRecentEntry(
            state.localRecent,
            row.clientSourceId,
            row.kind,
            what,
            row.path,
        )
    }

    val canPop = nav.popOrNull() != null
    BackHandler(enabled = canPop) {
        nav.popOrNull()?.let { nav = it }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when (val level = nav) {
            is RecentNav.Notebooks -> {
                Text("最近写入", color = Muted, fontSize = 13.sp)
                Button(
                    onClick = { vm.loadRecent() },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                ) { Text("刷新列表") }
                if (groups.isEmpty()) {
                    Text("暂无记录", color = Muted)
                } else {
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(groups, key = { "nb:${it.key}" }) { nb ->
                            EntityRow(
                                title = "📓 ${nb.name}",
                                subtitle = "${notebookWriteCount(nb)} 条写入 · ${nb.items.size} 个条目",
                                actionLabel = "打开条目",
                                onAction = { nav = RecentNav.Items(nb.key) },
                            )
                        }
                    }
                }
            }

            is RecentNav.Items -> {
                val nb = findNotebook(groups, level.notebookKey)
                LevelHeader(
                    title = nb?.name ?: "记录本",
                    subtitle = "选择条目查看写入历史",
                    onBack = { nav = RecentNav.Notebooks },
                    onRefresh = { vm.loadRecent() },
                )
                if (nb == null || nb.items.isEmpty()) {
                    Text("该记录本暂无条目记录", color = Muted)
                } else {
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(nb.items, key = { "it:${nb.key}:${it.key}" }) { ig ->
                            EntityRow(
                                title = "📄 ${ig.name}",
                                subtitle = "${ig.rows.size} 条记录",
                                actionLabel = "打开记录",
                                onAction = {
                                    nav = RecentNav.Records(level.notebookKey, ig.key)
                                },
                            )
                        }
                    }
                }
            }

            is RecentNav.Records -> {
                val nb = findNotebook(groups, level.notebookKey)
                val ig = findItem(groups, level.notebookKey, level.itemKey)
                LevelHeader(
                    title = ig?.name ?: "条目",
                    subtitle = listOfNotNull(nb?.name, ig?.name).joinToString(" / "),
                    onBack = { nav = RecentNav.Items(level.notebookKey) },
                    onRefresh = { vm.loadRecent() },
                )
                if (ig == null || ig.rows.isEmpty()) {
                    Text("该条目暂无写入记录", color = Muted)
                } else {
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(ig.rows, key = { keyOf(it) }) { row ->
                            val local = localFor(row)
                            val what = row.sourceLabel.ifBlank { row.preview.ifBlank { row.title } }
                            RecordRow(
                                row = row,
                                what = what,
                                local = local,
                                onOpenSource = { sourceRow = row },
                                onOpenFile = {
                                    vm.openRecentFile(row.clientSourceId, row.kind, what, row.path)
                                },
                                onDelete = {
                                    deleteTarget =
                                        DeleteTarget(
                                            row = row,
                                            local = local,
                                            protected =
                                                isProtectedSelection(
                                                    local = local,
                                                    queue = state.queue,
                                                    trash = state.trash,
                                                ),
                                        )
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    sourceRow?.let { row ->
        val what = row.sourceLabel.ifBlank { row.preview.ifBlank { row.title } }
        val body =
            listOf(
                "记录本：${row.notebookName.ifBlank { "—" }}",
                "条目：${row.itemTitle.ifBlank { row.title.ifBlank { "—" } }}",
                "类型：${row.kind}",
                "传了什么：$what",
                "来源文件：${row.sourcePath.ifBlank { "（无）" }}",
                "去处：${row.path.ifBlank { "—" }}",
                "时间：${row.at.ifBlank { "—" }}",
            ).joinToString("\n")
        AlertDialog(
            onDismissRequest = { sourceRow = null },
            title = { Text("传输来源 / 去处") },
            text = { Text(body, fontSize = 13.sp) },
            confirmButton = {
                TextButton(onClick = {
                    clipboard.setText(AnnotatedString(body))
                    sourceRow = null
                }) { Text("复制全部") }
            },
            dismissButton = {
                TextButton(onClick = { sourceRow = null }) { Text("关闭") }
            },
        )
    }

    deleteTarget?.let { target ->
        val local = target.local
        val hasCopy =
            local != null &&
                local.localPath.isNotBlank() &&
                !local.localCopyDeleted
        DeleteRecordDialog(
            protected = target.protected,
            hasCopy = hasCopy,
            onDismiss = { deleteTarget = null },
            onDeleteCopyOnly = {
                val id = local?.id
                if (id != null) {
                    vm.deleteRecentCopies(
                        setOf(id),
                        removeMetadata = false,
                        removeQueueReferences = target.protected,
                    )
                }
                deleteTarget = null
            },
            onDeleteRecord = {
                vm.deleteRecentRecords(
                    listOf(target.row),
                    removeQueueReferences = target.protected,
                )
                deleteTarget = null
            },
        )
    }
}

private data class DeleteTarget(
    val row: RecentDto,
    val local: LocalRecentEntry?,
    val protected: Boolean,
)

private fun isProtectedSelection(
    local: LocalRecentEntry?,
    queue: List<com.gaomu.suji.workshop.data.repo.QueueItem>,
    trash: List<com.gaomu.suji.workshop.data.repo.QueueItem>,
): Boolean {
    if (local == null) return false
    return (queue + trash).any { queued ->
        (local.clientSourceId.isNotBlank() && local.clientSourceId == queued.clientSourceId) ||
            (local.localPath.isNotBlank() && local.localPath == queued.localPath) ||
            (local.originalUri.isNotBlank() && local.originalUri == queued.originalUri)
    }
}

@Composable
private fun LevelHeader(
    title: String,
    subtitle: String,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(
                Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "返回",
                tint = TextPrimary,
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                color = TextPrimary,
                fontSize = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotBlank()) {
                Text(
                    subtitle,
                    color = Muted,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        TextButton(onClick = onRefresh) {
            Text("刷新", color = Accent, fontSize = 13.sp)
        }
    }
}

@Composable
private fun EntityRow(
    title: String,
    subtitle: String,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .background(Card, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                color = TextPrimary,
                fontSize = 15.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                subtitle,
                color = Muted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = onAction) {
            Text(actionLabel, fontSize = 12.sp)
        }
    }
}

@Composable
private fun RecordRow(
    row: RecentDto,
    what: String,
    local: LocalRecentEntry?,
    onOpenSource: () -> Unit,
    onOpenFile: () -> Unit,
    onDelete: () -> Unit,
) {
    val canOpen = row.kind == "voice" || row.kind == "file"
    val hasLocal = local?.localPath?.isNotBlank() == true && local.localCopyDeleted != true
    val hasOriginal = local?.originalUri?.isNotBlank() == true
    val showOpen = canOpen && (hasLocal || hasOriginal || row.kind == "voice" || row.kind == "file")

    Column(
        modifier =
            Modifier
                .fillMaxWidth()
                .background(Card, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f)) {
                val kindLabel = row.kind.ifBlank { "记录" }
                Text(
                    "$kindLabel · $what",
                    color = TextPrimary,
                    fontSize = 14.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    formatRecentAt(row.at),
                    color = Muted,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (local?.localCopyDeleted == true) {
                    Text("手机副本已删除", color = Danger, fontSize = 11.sp)
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onOpenSource) {
                Text("来源", fontSize = 12.sp)
            }
            if (showOpen) {
                OutlinedButton(onClick = onOpenFile) {
                    Text("打开文件", fontSize = 12.sp)
                }
            }
            Spacer(Modifier.weight(1f))
            OutlinedButton(
                onClick = onDelete,
                colors =
                    ButtonDefaults.outlinedButtonColors(
                        contentColor = Danger,
                    ),
            ) {
                Text("删除", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun DeleteRecordDialog(
    protected: Boolean,
    hasCopy: Boolean,
    onDismiss: () -> Unit,
    onDeleteCopyOnly: () -> Unit,
    onDeleteRecord: () -> Unit,
) {
    if (protected) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("来源仍在待发送") },
            text = {
                Text("删除本地副本会导致这些待发送数据无法发送。可以取消，或同时从待发送/垃圾箱移除后继续。")
            },
            confirmButton = {
                TextButton(onClick = onDeleteRecord) { Text("继续删除记录") }
            },
            dismissButton = {
                Row {
                    if (hasCopy) {
                        TextButton(onClick = onDeleteCopyOnly) { Text("仅删副本并移除队列") }
                    }
                    TextButton(onClick = onDismiss) { Text("取消") }
                }
            },
        )
    } else {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("删除这条最近记录？") },
            text = {
                Text(
                    if (hasCopy) {
                        "可只删手机副本（保留最近记录），或删除最近记录（本地元数据 + 可清理副本）。不影响电脑 vault。"
                    } else {
                        "只删除手机本地最近记录，不影响电脑 vault。"
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = onDeleteRecord) { Text("删除记录") }
            },
            dismissButton = {
                Row {
                    if (hasCopy) {
                        TextButton(onClick = onDeleteCopyOnly) { Text("仅删副本") }
                    }
                    TextButton(onClick = onDismiss) { Text("取消") }
                }
            },
        )
    }
}

/** Prefer short local-looking timestamps; fall back to raw string. */
fun formatRecentAt(raw: String): String {
    if (raw.isBlank()) return "—"
    // 2026-08-07T09:28:58.352Z → 08-07 09:28
    val iso =
        Regex("""^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})""")
            .find(raw)
    if (iso != null) {
        val (_, m, d, hh, mm) = iso.destructured
        return "$m-$d $hh:$mm"
    }
    return raw
}
