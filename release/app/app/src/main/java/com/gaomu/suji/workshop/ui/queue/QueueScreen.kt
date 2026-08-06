package com.gaomu.suji.workshop.ui.queue

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gaomu.suji.workshop.ui.SujiViewModel
import com.gaomu.suji.workshop.ui.theme.Accent
import com.gaomu.suji.workshop.ui.theme.Danger
import com.gaomu.suji.workshop.ui.theme.Muted
import com.gaomu.suji.workshop.ui.theme.TextPrimary
// Danger used for lastError
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun QueueScreen(vm: SujiViewModel) {
    val state by vm.ui.collectAsState()
    var selected by remember { mutableStateOf(setOf<String>()) }
    val fmt = remember { SimpleDateFormat("yyyy/M/d HH:mm:ss", Locale.CHINA) }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("待发送缓存（离线可继续录入）", color = Muted, fontSize = 13.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { selected = state.queue.map { it.id }.toSet() }, modifier = Modifier.weight(1f)) {
                Text("全选")
            }
            OutlinedButton(onClick = { selected = emptySet() }, modifier = Modifier.weight(1f)) {
                Text("取消全选")
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    vm.sendQueueIds(selected)
                    selected = emptySet()
                },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("发送勾选", fontSize = 13.sp) }
            Button(
                onClick = { vm.sendQueueIds(state.queue.map { it.id }.toSet()) },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("全部发送", fontSize = 13.sp) }
        }
        Button(
            onClick = {
                vm.deleteQueueToTrash(selected)
                selected = emptySet()
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Danger),
        ) { Text("删除勾选 → 垃圾箱") }

        if (state.sendProgress.isNotBlank()) {
            Text(state.sendProgress, color = Accent, fontSize = 13.sp)
        }
        Text(state.statusLine, color = Muted, fontSize = 12.sp)

        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxSize()) {
            items(state.queue, key = { it.id }) { item ->
                Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                    Checkbox(
                        checked = item.id in selected,
                        onCheckedChange = { checked ->
                            selected = if (checked) selected + item.id else selected - item.id
                        },
                    )
                    Column(Modifier.padding(top = 10.dp)) {
                        Text(
                            "${item.kind.name.lowercase()} · ${item.title.ifBlank { item.fileName }.ifBlank { "未命名" }}",
                            color = TextPrimary,
                            fontSize = 14.sp,
                        )
                        Text(
                            "目标 ${item.targetLabel.ifBlank { "新建条目" }} · ${fmt.format(Date(item.createdAt))}",
                            color = Muted,
                            fontSize = 12.sp,
                        )
                        if (item.lastError.isNotBlank()) {
                            Text("失败：${item.lastError}", color = Danger, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}
