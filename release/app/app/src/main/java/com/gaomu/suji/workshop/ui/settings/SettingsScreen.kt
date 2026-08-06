package com.gaomu.suji.workshop.ui.settings

import android.annotation.SuppressLint
import android.Manifest
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.gaomu.suji.workshop.data.prefs.AudioFormat
import com.gaomu.suji.workshop.ui.UiState
import com.gaomu.suji.workshop.ui.theme.Accent
import com.gaomu.suji.workshop.ui.theme.Bg
import com.gaomu.suji.workshop.ui.theme.Border
import com.gaomu.suji.workshop.ui.theme.Muted
import com.gaomu.suji.workshop.ui.theme.TextPrimary
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.atomic.AtomicBoolean
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import android.content.pm.PackageManager

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: UiState,
    onBack: () -> Unit,
    onSaveLink: (String) -> Unit,
    onSaveQr: (String) -> Unit,
    onTest: () -> Unit,
    onAudioFormat: (AudioFormat) -> Unit,
    onSaveParts: (String, String, String) -> Unit,
    onRetentionDays: (Int) -> Unit = {},
) {
    var linkText by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("27124") }
    var token by remember { mutableStateOf("") }
    var showAdvanced by remember { mutableStateOf(false) }
    var showScanner by remember { mutableStateOf(false) }
    val ctx = LocalContext.current

    val camPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
            showScanner = ok
        }

    val colors =
        OutlinedTextFieldDefaults.colors(
            focusedTextColor = TextPrimary,
            unfocusedTextColor = TextPrimary,
            focusedBorderColor = Accent,
            unfocusedBorderColor = Border,
            cursorColor = Accent,
            focusedLabelColor = Muted,
            unfocusedLabelColor = Muted,
        )

    Scaffold(
        containerColor = Bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg, titleContentColor = TextPrimary),
                title = { Text("连接与设置") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = TextPrimary)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("当前：${if (state.configured) state.baseUrl else "未配置"}", color = Muted, fontSize = 13.sp)
            Text(
                if (state.connected) "状态：已连接电脑" else "状态：未连通",
                color = TextPrimary,
                fontSize = 14.sp,
            )

            Text("方式 A · 粘贴完整链接", color = TextPrimary, fontSize = 16.sp)
            Text("从电脑插件「显示/复制手机链接」复制后粘贴。", color = Muted, fontSize = 12.sp)
            OutlinedTextField(
                value = linkText,
                onValueChange = { linkText = it },
                modifier = Modifier.fillMaxWidth().height(100.dp),
                placeholder = { Text("http://100.x.x.x:27124/?t=…", color = Muted) },
                colors = colors,
            )
            Button(
                onClick = { onSaveLink(linkText) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("保存链接") }

            Text("方式 C · 扫描二维码", color = TextPrimary, fontSize = 16.sp)
            Button(
                onClick = {
                    val granted =
                        ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) ==
                            PackageManager.PERMISSION_GRANTED
                    if (granted) showScanner = true else camPermission.launch(Manifest.permission.CAMERA)
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text(if (showScanner) "扫码中…" else "打开扫码") }

            if (showScanner) {
                Box(Modifier.fillMaxWidth().height(240.dp)) {
                    QrScanner(
                        onResult = { value ->
                            showScanner = false
                            linkText = value
                            onSaveQr(value)
                        },
                        onClose = { showScanner = false },
                    )
                }
            }

            Button(
                onClick = onTest,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) { Text("测试连接") }

            TextButtonLike(showAdvanced, onClick = { showAdvanced = !showAdvanced }) {
                Text(if (showAdvanced) "收起分栏编辑" else "展开分栏编辑主机/端口/令牌")
            }
            if (showAdvanced) {
                OutlinedTextField(host, { host = it }, label = { Text("主机") }, modifier = Modifier.fillMaxWidth(), colors = colors)
                OutlinedTextField(port, { port = it }, label = { Text("端口") }, modifier = Modifier.fillMaxWidth(), colors = colors)
                OutlinedTextField(token, { token = it }, label = { Text("令牌 token") }, modifier = Modifier.fillMaxWidth(), colors = colors)
                Button(
                    onClick = { onSaveParts(host, port, token) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                ) { Text("保存分栏配置") }
            }

            Spacer(Modifier.height(8.dp))
            Text("语音默认格式", color = TextPrimary, fontSize = 16.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AudioFormat.entries.forEach { fmt ->
                    FilterChip(
                        selected = state.audioFormat == fmt,
                        onClick = { onAudioFormat(fmt) },
                        label = { Text(fmt.label, fontSize = 12.sp) },
                    )
                }
            }

            Spacer(Modifier.height(8.dp))
            Text("待发送自动清理", color = TextPrimary, fontSize = 16.sp)
            Text("默认永久保留。过期项会移入垃圾箱；垃圾箱内删除为永久删除。", color = Muted, fontSize = 12.sp)
            val retentionOptions = listOf(0 to "永久", 7 to "7 天", 30 to "30 天", 90 to "90 天")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                retentionOptions.forEach { (days, label) ->
                    FilterChip(
                        selected = state.queueRetentionDays == days,
                        onClick = { onRetentionDays(days) },
                        label = { Text(label, fontSize = 12.sp) },
                    )
                }
            }

            if (state.statusLine.isNotBlank()) {
                Text(state.statusLine, color = Muted, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun TextButtonLike(expanded: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = Border, contentColor = TextPrimary),
        modifier = Modifier.fillMaxWidth(),
    ) { content() }
}

@Composable
@SuppressLint("UnsafeOptInUsageError")
@OptIn(ExperimentalMaterial3Api::class)
private fun QrScanner(onResult: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val handled = remember { AtomicBoolean(false) }

    DisposableEffect(Unit) {
        onDispose { handled.set(true) }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
            cameraProviderFuture.addListener(
                {
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also { p ->
                        p.setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val analysis =
                        ImageAnalysis.Builder()
                            .setTargetResolution(Size(1280, 720))
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                    val scanner = BarcodeScanning.getClient()
                    analysis.setAnalyzer(ContextCompat.getMainExecutor(ctx)) { imageProxy ->
                        val media = imageProxy.image
                        if (media != null && !handled.get()) {
                            val image = InputImage.fromMediaImage(media, imageProxy.imageInfo.rotationDegrees)
                            scanner.process(image)
                                .addOnSuccessListener { bars ->
                                    val raw = bars.firstOrNull()?.rawValue
                                    if (!raw.isNullOrBlank() && handled.compareAndSet(false, true)) {
                                        onResult(raw)
                                    }
                                }
                                .addOnCompleteListener { imageProxy.close() }
                        } else {
                            imageProxy.close()
                        }
                    }
                    try {
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    } catch (_: Exception) {
                        onClose()
                    }
                },
                ContextCompat.getMainExecutor(ctx),
            )
            previewView
        },
    )
}
