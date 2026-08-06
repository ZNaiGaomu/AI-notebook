package com.gaomu.suji.workshop.ui.recent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gaomu.suji.workshop.net.RecentDto
import com.gaomu.suji.workshop.ui.SujiViewModel
import com.gaomu.suji.workshop.ui.theme.Accent
import com.gaomu.suji.workshop.ui.theme.Danger
import com.gaomu.suji.workshop.ui.theme.Muted
import com.gaomu.suji.workshop.ui.theme.TextPrimary

@Composable
fun RecentScreen(vm: SujiViewModel) {
    val state by vm.ui.collectAsState()
    LaunchedEffect(state.connected) { if (state.connected) vm.loadRecent() }
    var selectionMode by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var dialog by remember { mutableStateOf<DeleteDialog?>(null) }
    val clipboard = LocalClipboardManager.current

    val rows = state.recent.filterNot { row ->
        val key = row.clientSourceId.takeIf { it.isNotBlank() }?.let { "client:$it" }
            ?: row.path.takeIf { it.isNotBlank() }?.let { "path:${row.kind}:$it" }
        key != null && key in state.hiddenRecentKeys
    }
    val keyOf: (RecentDto) -> String = { row ->
        row.clientSourceId.ifBlank { "${row.kind}|${row.path}|${row.at}|${row.title}" }
    }
    val localFor: (RecentDto) -> com.gaomu.suji.workshop.data.repo.LocalRecentEntry? = { row ->
        state.localRecent.firstOrNull { local ->
            (row.clientSourceId.isNotBlank() && local.clientSourceId == row.clientSourceId) ||
                (local.kind == row.kind && local.destPath == row.path && row.path.isNotBlank())
        }
    }
    val selectedLocalIds = rows.filter { keyOf(it) in selected }.mapNotNull(localFor).map { it.id }.toSet()
    val selectedEntries = state.localRecent.filter { it.id in selectedLocalIds }
    val protectedSelection = (state.queue + state.trash).any { queued ->
        selectedEntries.any { local ->
            (local.clientSourceId.isNotBlank() && local.clientSourceId == queued.clientSourceId) ||
                (local.localPath.isNotBlank() && local.localPath == queued.localPath) ||
                (local.originalUri.isNotBlank() && local.originalUri == queued.originalUri)
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("最近写入（记录本 → 条目）", color = Muted, fontSize = 13.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { vm.loadRecent() },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("刷新列表") }
            OutlinedButton(
                onClick = {
                    selectionMode = !selectionMode
                    if (!selectionMode) selected = emptySet()
                },
                modifier = Modifier.weight(1f),
            ) { Text(if (selectionMode) "取消选择" else "选择") }
        }
        if (selectionMode) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { selected = rows.map(keyOf).toSet() }, modifier = Modifier.weight(1f)) { Text("全选") }
                OutlinedButton(onClick = { selected = emptySet() }, modifier = Modifier.weight(1f)) { Text("取消全选") }
            }
            Text("已选择 ${selected.size} 条", color = Accent, fontSize = 13.sp)
            Button(
                onClick = {
                    if (selectedLocalIds.isNotEmpty()) {
                        dialog = if (protectedSelection) DeleteDialog.ProtectedCopyOnly else DeleteDialog.CopyOnly
                    }
                },
                enabled = selectedLocalIds.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Danger),
            ) { Text("仅删除手机副本") }
            Button(
                onClick = {
                    if (selectedLocalIds.isNotEmpty()) {
                        dialog = if (protectedSelection) DeleteDialog.ProtectedCopyAndMetadata else DeleteDialog.CopyAndMetadata
                    }
                },
                enabled = selectedLocalIds.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Danger),
            ) { Text("删除副本和最近记录") }
        }
        if (rows.isEmpty()) Text("暂无记录", color = Muted)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxSize()) {
            items(rows, key = keyOf) { row ->
                val key = keyOf(row)
                val local = localFor(row)
                val what = row.sourceLabel.ifBlank { row.preview.ifBlank { row.title } }
                var showSource by remember(key) { mutableStateOf(false) }
                Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                    if (selectionMode) {
                        Checkbox(checked = key in selected, onCheckedChange = { checked ->
                            selected = if (checked) selected + key else selected - key
                        })
                    }
                    Column(Modifier.padding(start = if (selectionMode) 4.dp else 0.dp, bottom = 10.dp)) {
                        if (row.kind.isNotBlank()) Text(row.kind, color = Accent, fontSize = 11.sp)
                        Text(row.at.ifBlank { row.title }, color = Muted, fontSize = 12.sp)
                        Text("传了什么：$what", color = TextPrimary, fontSize = 13.sp)
                        if (row.sourcePath.isNotBlank()) Text("来源文件：${row.sourcePath}", color = Muted, fontSize = 11.sp)
                        if (row.path.isNotBlank()) Text("去处：${row.path}", color = Muted, fontSize = 11.sp)
                        if (local?.localCopyDeleted == true) Text("手机副本已删除", color = Danger, fontSize = 11.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedButton(onClick = { showSource = true }) { Text("查看来源", fontSize = 12.sp) }
                            if (row.kind == "voice" || row.kind == "file") {
                                OutlinedButton(onClick = { vm.openLocalSource(row.clientSourceId, row.kind, what, row.path) }) { Text("打开手机副本", fontSize = 12.sp) }
                                if (local?.originalUri?.isNotBlank() == true) {
                                    OutlinedButton(onClick = { vm.openOriginalSource(row.clientSourceId, row.kind, what, row.path) }) { Text("打开原始文件", fontSize = 12.sp) }
                                }
                            }
                        }
                    }
                }
                if (showSource) {
                    val body = listOf("类型：${row.kind}", "传了什么：$what", "来源文件：${row.sourcePath.ifBlank { "（无）" }}", "去处：${row.path.ifBlank { "—" }}", "时间：${row.at.ifBlank { "—" }}").joinToString("\n")
                    AlertDialog(onDismissRequest = { showSource = false }, title = { Text("传输来源 / 去处") }, text = { Text(body, fontSize = 13.sp) }, confirmButton = { TextButton(onClick = { clipboard.setText(AnnotatedString(body)); showSource = false }) { Text("复制全部") } }, dismissButton = { TextButton(onClick = { showSource = false }) { Text("关闭") } })
                }
            }
        }
    }
    when (dialog) {
        DeleteDialog.CopyOnly -> DeleteChoiceDialog(
            title = "删除手机副本？",
            text = "保留最近记录和电脑端资料，只删除 App 私有副本。",
            onDismiss = { dialog = null },
            onConfirm = { vm.deleteRecentCopies(selectedLocalIds, false); selected = emptySet(); selectionMode = false; dialog = null },
        )
        DeleteDialog.CopyAndMetadata -> DeleteChoiceDialog(
            title = "删除副本和最近记录？",
            text = "只删除手机副本与手机本地元数据，不影响电脑 vault。",
            onDismiss = { dialog = null },
            onConfirm = { vm.deleteRecentCopies(selectedLocalIds, true); selected = emptySet(); selectionMode = false; dialog = null },
        )
        DeleteDialog.ProtectedCopyOnly, DeleteDialog.ProtectedCopyAndMetadata -> AlertDialog(
            onDismissRequest = { dialog = null },
            title = { Text("文件仍被待发送引用") },
            text = { Text("删除本地副本会导致这些待发送数据无法发送。可以取消，或同时从待发送/垃圾箱移除后继续。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteRecentCopies(
                        selectedLocalIds,
                        removeMetadata = dialog == DeleteDialog.ProtectedCopyAndMetadata,
                        removeQueueReferences = true,
                    )
                    selected = emptySet()
                    selectionMode = false
                    dialog = null
                }) { Text("移除引用并删除") }
            },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("取消") } },
        )
        null -> Unit
    }
}

private enum class DeleteDialog { CopyOnly, CopyAndMetadata, ProtectedCopyOnly, ProtectedCopyAndMetadata }

@Composable
private fun DeleteChoiceDialog(title: String, text: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = onConfirm) { Text("确认删除") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
