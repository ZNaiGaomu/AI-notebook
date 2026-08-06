package com.gaomu.suji.workshop.ui.compose

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.gaomu.suji.workshop.ui.SujiViewModel
import com.gaomu.suji.workshop.ui.theme.Accent
import com.gaomu.suji.workshop.ui.theme.Border
import com.gaomu.suji.workshop.ui.theme.Danger
import com.gaomu.suji.workshop.ui.theme.Muted
import com.gaomu.suji.workshop.ui.theme.TextPrimary

@Composable
fun ComposeScreen(vm: SujiViewModel) {
    val state by vm.ui.collectAsState()
    val ctx = LocalContext.current
    var showNewNb by remember { mutableStateOf(false) }
    var showNewItem by remember { mutableStateOf(false) }
    var nbName by remember { mutableStateOf("") }
    var nbTemplate by remember { mutableStateOf("blank") }
    var itemTitle by remember { mutableStateOf("") }
    var itemBody by remember { mutableStateOf("") }
    var nbExpanded by remember { mutableStateOf(false) }
    var itemExpanded by remember { mutableStateOf(false) }
    var tplExpanded by remember { mutableStateOf(false) }

    val filePickLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            vm.setSelectedFiles(uris)
        }
    val micPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) vm.startRecording()
        }

    val fieldColors =
        OutlinedTextFieldDefaults.colors(
            focusedTextColor = TextPrimary,
            unfocusedTextColor = TextPrimary,
            focusedBorderColor = Accent,
            unfocusedBorderColor = Border,
            cursorColor = Accent,
            focusedLabelColor = Muted,
            unfocusedLabelColor = Muted,
        )

    val templates =
        listOf(
            "blank" to "空白本",
            "literature" to "文献本",
            "idea" to "灵感本",
            "meeting" to "会议本",
            "cabinet-first" to "收藏向",
        )

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CardBox {
            Text("发送到哪个记录本", color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            val nbLabel =
                state.notebooks.find { it.id == state.selectedNotebookId }?.name
                    ?: if (state.notebooks.isEmpty()) "（暂无记录本）" else "请选择"
            BoxDropdown(
                label = nbLabel,
                expanded = nbExpanded,
                onExpand = { nbExpanded = true },
                onDismiss = { nbExpanded = false },
            ) {
                state.notebooks.forEach { nb ->
                    DropdownMenuItem(
                        text = { Text(nb.name) },
                        onClick = {
                            vm.selectNotebook(nb.id)
                            nbExpanded = false
                        },
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { showNewNb = !showNewNb }, modifier = Modifier.weight(1f)) {
                    Text(if (showNewNb) "收起" else "新建记录本")
                }
                OutlinedButton(onClick = { showNewItem = !showNewItem }, modifier = Modifier.weight(1f)) {
                    Text(if (showNewItem) "收起" else "新建条目")
                }
            }
            if (showNewNb) {
                OutlinedTextField(
                    value = nbName,
                    onValueChange = { nbName = it },
                    label = { Text("记录本名称") },
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors,
                )
                BoxDropdown(
                    label = templates.find { it.first == nbTemplate }?.second ?: "空白本",
                    expanded = tplExpanded,
                    onExpand = { tplExpanded = true },
                    onDismiss = { tplExpanded = false },
                    caption = "模板",
                ) {
                    templates.forEach { (id, label) ->
                        DropdownMenuItem(
                            text = { Text(label) },
                            onClick = {
                                nbTemplate = id
                                tplExpanded = false
                            },
                        )
                    }
                }
                Button(
                    onClick = {
                        vm.createNotebook(nbName.trim(), nbTemplate)
                        nbName = ""
                        showNewNb = false
                    },
                    enabled = nbName.isNotBlank() && !state.busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                ) { Text("创建并选中") }
            }

            Spacer(Modifier.height(8.dp))
            Text("发送到哪个条目", color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            val itemLabel =
                if (state.selectedItemId.isBlank()) {
                    "＋ 新建条目（发送时自动生成）"
                } else {
                    state.items.find { it.id == state.selectedItemId }?.title ?: "已有条目"
                }
            BoxDropdown(
                label = itemLabel,
                expanded = itemExpanded,
                onExpand = { itemExpanded = true },
                onDismiss = { itemExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text("＋ 新建条目（发送时自动生成）") },
                    onClick = {
                        vm.selectItem("")
                        itemExpanded = false
                    },
                )
                state.items.forEach { row ->
                    DropdownMenuItem(
                        text = { Text(row.title.ifBlank { "未命名" }) },
                        onClick = {
                            vm.selectItem(row.id)
                            itemExpanded = false
                        },
                    )
                }
            }
            Text(
                "选“新建条目”=本次发送会新建；选已有=追加到正文末尾。",
                color = Muted,
                fontSize = 12.sp,
            )
            if (showNewItem) {
                OutlinedTextField(
                    value = itemTitle,
                    onValueChange = { itemTitle = it },
                    label = { Text("条目名称") },
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors,
                )
                OutlinedTextField(
                    value = itemBody,
                    onValueChange = { itemBody = it },
                    label = { Text("初始正文（可空）") },
                    modifier = Modifier.fillMaxWidth().height(100.dp),
                    colors = fieldColors,
                )
                Button(
                    onClick = {
                        vm.createItem(itemTitle.trim(), itemBody)
                        itemTitle = ""
                        itemBody = ""
                        showNewItem = false
                    },
                    enabled = itemTitle.isNotBlank() && !state.busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                ) { Text("创建条目并选中") }
            }
        }

        CardBox {
            Text("文字 / 杂乱信息", color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = state.text,
                onValueChange = vm::setText,
                placeholder = { Text("随便写、粘贴链接、待办、聊天摘录…", color = Muted) },
                modifier = Modifier.fillMaxWidth().height(140.dp),
                colors = fieldColors,
            )
            ActionRow(
                onCache = { vm.cacheText() },
                onSend = { vm.sendTextNow(organize = true) },
                onInbox = { vm.sendTextNow(organize = false) },
                enabled = !state.busy,
            )
        }

        CardBox {
            Text("语音（原生麦克风，不依赖 HTTPS）", color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            Text(
                "%02d:%02d".format(state.recordSeconds / 60, state.recordSeconds % 60),
                color = TextPrimary,
                fontSize = 28.sp,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    onClick = {
                        val granted =
                            ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
                                PackageManager.PERMISSION_GRANTED
                        if (granted) vm.startRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    },
                    enabled = !state.recording && !state.busy,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                ) { Text("开始录音") }
                Button(
                    onClick = { vm.stopRecording() },
                    enabled = state.recording,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = Danger),
                ) { Text("停止录音") }
            }
            ActionRow(
                onCache = { vm.cacheVoice() },
                onSend = { vm.sendVoiceNow(organize = true) },
                onInbox = { vm.sendVoiceNow(organize = false) },
                enabled = state.voiceReady && !state.busy && !state.recording,
            )
        }

        CardBox {
            Text("文件上传（文档/图片/音视频）", color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { filePickLauncher.launch(arrayOf("*/*")) },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("选择文件") }
            if (state.selectedFilesLabel.isNotBlank()) {
                Text(state.selectedFilesLabel, color = Muted, fontSize = 12.sp)
            }
            ActionRow(
                onCache = { vm.processSelectedFiles(organize = true, sendNow = false) },
                onSend = { vm.processSelectedFiles(organize = true, sendNow = true) },
                onInbox = { vm.processSelectedFiles(organize = false, sendNow = true) },
                enabled = !state.busy && state.selectedFilesLabel.isNotBlank(),
            )
            Text("请先选择文件，再点发送。普通文件进附件；仅收件箱只存说明。", color = Muted, fontSize = 12.sp)
        }

        if (state.statusLine.isNotBlank()) {
            Text(state.statusLine, color = Muted, fontSize = 13.sp)
        }
        if (state.sendProgress.isNotBlank()) {
            Text(state.sendProgress, color = Accent, fontSize = 13.sp)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun BoxDropdown(
    label: String,
    expanded: Boolean,
    onExpand: () -> Unit,
    onDismiss: () -> Unit,
    caption: String? = null,
    content: @Composable () -> Unit,
) {
    Column {
        if (caption != null) {
            Text(caption, color = Muted, fontSize = 12.sp)
            Spacer(Modifier.height(4.dp))
        }
        androidx.compose.foundation.layout.Box {
            Text(
                text = label,
                color = TextPrimary,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .border(1.dp, Border, RoundedCornerShape(10.dp))
                        .clickable(onClick = onExpand)
                        .padding(14.dp),
            )
            DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
                content()
            }
        }
    }
}

@Composable
private fun CardBox(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, Border, RoundedCornerShape(14.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        content()
    }
}

@Composable
private fun ActionRow(
    onCache: () -> Unit,
    onSend: () -> Unit,
    onInbox: () -> Unit,
    enabled: Boolean,
    cacheLabel: String = "加入待发送",
    sendLabel: String = "立即发送并整理",
    inboxLabel: String = "仅收件箱",
) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = onCache,
            enabled = enabled,
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Accent),
        ) { Text(cacheLabel, fontSize = 12.sp) }
        Button(
            onClick = onSend,
            enabled = enabled,
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Accent),
        ) { Text(sendLabel, fontSize = 12.sp) }
    }
    OutlinedButton(
        onClick = onInbox,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary),
    ) { Text(inboxLabel) }
}
