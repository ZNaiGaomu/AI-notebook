package com.gaomu.suji.workshop.ui.trash

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

@Composable
fun TrashScreen(vm: SujiViewModel) {
    val state by vm.ui.collectAsState()
    var selected by remember { mutableStateOf(setOf<String>()) }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("缓存垃圾箱（移入后保留 30 天）", color = Muted, fontSize = 13.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { selected = state.trash.map { it.id }.toSet() }, modifier = Modifier.weight(1f)) {
                Text("全选")
            }
            OutlinedButton(onClick = { selected = emptySet() }, modifier = Modifier.weight(1f)) {
                Text("取消全选")
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    vm.restoreTrash(selected)
                    selected = emptySet()
                },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("恢复勾选") }
            Button(
                onClick = {
                    vm.purgeTrash(selected)
                    selected = emptySet()
                },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Danger),
            ) { Text("永久删除勾选") }
        }
        Button(
            onClick = {
                vm.emptyTrash()
                selected = emptySet()
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Danger),
        ) { Text("清空垃圾箱") }

        if (state.trash.isEmpty()) {
            Text("垃圾箱为空", color = Muted)
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(state.trash, key = { it.id }) { item ->
                Row(verticalAlignment = Alignment.Top) {
                    Checkbox(
                        checked = item.id in selected,
                        onCheckedChange = { checked ->
                            selected = if (checked) selected + item.id else selected - item.id
                        },
                    )
                    Column(Modifier.padding(top = 10.dp)) {
                        Text(item.title.ifBlank { item.fileName }.ifBlank { item.kind.name }, color = TextPrimary)
                        Text(item.targetLabel, color = Muted, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}
