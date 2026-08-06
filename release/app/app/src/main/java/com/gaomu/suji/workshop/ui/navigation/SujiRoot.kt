package com.gaomu.suji.workshop.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.gaomu.suji.workshop.ui.compose.ComposeScreen
import com.gaomu.suji.workshop.ui.queue.QueueScreen
import com.gaomu.suji.workshop.ui.recent.RecentScreen
import com.gaomu.suji.workshop.ui.settings.SettingsScreen
import com.gaomu.suji.workshop.ui.SujiViewModel
import com.gaomu.suji.workshop.ui.theme.Accent
import com.gaomu.suji.workshop.ui.theme.Bg
import com.gaomu.suji.workshop.ui.theme.Ok
import com.gaomu.suji.workshop.ui.theme.TextPrimary
import com.gaomu.suji.workshop.ui.theme.Warn
import com.gaomu.suji.workshop.ui.trash.TrashScreen

private data class Tab(val title: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SujiRoot(vm: SujiViewModel = viewModel()) {
    val state by vm.ui.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    var showSettings by remember { mutableIntStateOf(0) } // 0 main, 1 settings

    val tabs =
        listOf(
            Tab("录入", Icons.Outlined.Edit),
            Tab("待发送", Icons.Outlined.Inventory2),
            Tab("垃圾箱", Icons.Outlined.Delete),
            Tab("最近", Icons.Outlined.History),
        )

    if (showSettings == 1) {
        SettingsScreen(
            state = state,
            onBack = { showSettings = 0 },
            onSaveLink = { vm.saveLinkText(it) },
            onSaveQr = { vm.saveLinkText(it) },
            onTest = { vm.refreshConnection() },
            onAudioFormat = { vm.setAudioFormat(it) },
            onSaveParts = { h, p, t -> vm.saveParts(h, p, t) },
            onRetentionDays = { vm.setQueueRetentionDays(it) },
        )
        return
    }

    Scaffold(
        containerColor = Bg,
        topBar = {
            TopAppBar(
                colors =
                    TopAppBarDefaults.topAppBarColors(
                        containerColor = Bg,
                        titleContentColor = TextPrimary,
                    ),
                title = {
                    androidx.compose.foundation.layout.Column {
                        Text("高木的速记工坊", fontSize = 18.sp, color = TextPrimary)
                        Text(
                            text =
                                when {
                                    !state.configured -> "未配置链接 · 点右上角设置"
                                    state.connected -> "已连接电脑"
                                    else -> "未连通 · 可先本地缓存"
                                },
                            fontSize = 12.sp,
                            color =
                                when {
                                    !state.configured -> Warn
                                    state.connected -> Ok
                                    else -> Warn
                                },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showSettings = 1 }) {
                        Icon(Icons.Outlined.Settings, contentDescription = "设置", tint = Accent)
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar(containerColor = Bg) {
                tabs.forEachIndexed { index, t ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        icon = { Icon(t.icon, contentDescription = t.title) },
                        label = { Text(t.title) },
                    )
                }
            }
        },
    ) { padding ->
        androidx.compose.foundation.layout.Box(Modifier.padding(padding)) {
            when (tab) {
                0 -> ComposeScreen(vm)
                1 -> QueueScreen(vm)
                2 -> TrashScreen(vm)
                else -> RecentScreen(vm)
            }
        }
    }
}
