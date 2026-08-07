package com.gaomu.suji.workshop.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.gaomu.suji.workshop.SujiApp
import com.gaomu.suji.workshop.data.prefs.AudioFormat
import com.gaomu.suji.workshop.data.repo.QueueItem
import com.gaomu.suji.workshop.data.repo.QueueKind
import com.gaomu.suji.workshop.net.ItemDto
import com.gaomu.suji.workshop.net.NotebookDto
import com.gaomu.suji.workshop.net.RecentDto
import com.gaomu.suji.workshop.util.LinkParser
import com.gaomu.suji.workshop.voice.AudioRecorder
import com.gaomu.suji.workshop.data.repo.LocalRecentStore
import com.gaomu.suji.workshop.data.repo.LocalRecentEntry
import com.gaomu.suji.workshop.data.repo.OriginalSourceMetadata
import com.gaomu.suji.workshop.data.repo.originalSourceMetadataMatches
import com.gaomu.suji.workshop.voice.RecordedClip
import androidx.core.content.FileProvider
import com.gaomu.suji.workshop.data.source.isAppOwnedSource
import com.gaomu.suji.workshop.data.source.distinctUriStrings
import java.io.File
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class UiState(
    val configured: Boolean = false,
    val connected: Boolean = false,
    val baseUrl: String = "",
    val token: String = "",
    val audioFormat: AudioFormat = AudioFormat.M4A,
    val statusLine: String = "",
    val notebooks: List<NotebookDto> = emptyList(),
    val items: List<ItemDto> = emptyList(),
    val selectedNotebookId: String = "",
    val selectedItemId: String = "",
    val text: String = "",
    val recording: Boolean = false,
    val recordSeconds: Int = 0,
    val voiceReady: Boolean = false,
    val queue: List<QueueItem> = emptyList(),
    val trash: List<QueueItem> = emptyList(),
    val recent: List<RecentDto> = emptyList(),
    val localRecent: List<LocalRecentEntry> = emptyList(),
    val hiddenRecentKeys: Set<String> = emptySet(),
    val busy: Boolean = false,
    val sendProgress: String = "",
    val queueRetentionDays: Int = 0,
    val selectedFilesLabel: String = "",
)

class SujiViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = SujiApp.instance.settings
    private val bridge = SujiApp.instance.bridge
    private val queueRepo = SujiApp.instance.queue
    private val localRecent = LocalRecentStore(app)
    private val recorder = AudioRecorder(app)

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var tickJob: Job? = null
    private var lastVoiceB64: String = ""
    private var lastVoiceMime: String = ""
    private var lastVoiceLocalPath: String = ""
    private var pendingFileUris: List<Uri> = emptyList()

    init {
        viewModelScope.launch {
            queueRepo.load()
            settings.settingsFlow.collect { s ->
                _ui.update {
                    it.copy(
                        configured = s.isConfigured,
                        baseUrl = s.baseUrl,
                        token = s.token,
                        audioFormat = s.audioFormat,
                        selectedNotebookId = s.lastNotebookId.ifBlank { it.selectedNotebookId },
                        selectedItemId = s.lastItemId.ifBlank { it.selectedItemId },
                        queueRetentionDays = s.queueRetentionDays,
                    )
                }
                queueRepo.applyRetention(s.queueRetentionDays)
                if (s.isConfigured) refreshConnection()
            }
        }
        viewModelScope.launch {
            queueRepo.queue.collect { q -> _ui.update { it.copy(queue = q) } }
        }
        viewModelScope.launch {
            queueRepo.trash.collect { t -> _ui.update { it.copy(trash = t) } }
        }
    }

    fun setText(v: String) = _ui.update { it.copy(text = v) }

    fun selectNotebook(id: String) {
        _ui.update { it.copy(selectedNotebookId = id, selectedItemId = "") }
        viewModelScope.launch {
            settings.setLastTarget(id, "")
            runCatching { bridge.setDefaultNotebook(id) }
            refreshItems()
        }
    }

    fun selectItem(id: String) {
        _ui.update { it.copy(selectedItemId = id) }
        viewModelScope.launch {
            settings.setLastTarget(_ui.value.selectedNotebookId, id)
        }
    }

    fun saveLinkText(raw: String) {
        viewModelScope.launch {
            LinkParser.parse(raw).fold(
                onSuccess = {
                    settings.saveLink(it)
                    _ui.update { st -> st.copy(statusLine = "已保存链接", configured = true) }
                    refreshConnection()
                },
                onFailure = { e -> _ui.update { it.copy(statusLine = e.message ?: "链接无效") } },
            )
        }
    }

    fun saveParts(host: String, portStr: String, token: String) {
        viewModelScope.launch {
            val port = portStr.toIntOrNull() ?: 27124
            LinkParser.buildFromParts(host, port, token).fold(
                onSuccess = {
                    settings.saveLink(it)
                    refreshConnection()
                },
                onFailure = { e -> _ui.update { it.copy(statusLine = e.message ?: "保存失败") } },
            )
        }
    }

    fun setAudioFormat(format: AudioFormat) {
        viewModelScope.launch { settings.setAudioFormat(format) }
    }

    fun setQueueRetentionDays(days: Int) {
        viewModelScope.launch {
            settings.setQueueRetentionDays(days)
            queueRepo.applyRetention(days)
            _ui.update {
                it.copy(
                    statusLine = if (days <= 0) "待发送：永久保留" else "待发送：${days} 天后移入垃圾箱",
                )
            }
        }
    }

    fun refreshConnection() {
        viewModelScope.launch {
            val s = settings.settingsFlow.first()
            if (!s.isConfigured) {
                _ui.update { it.copy(connected = false, statusLine = "请先配置链接") }
                return@launch
            }
            val (ok, notebooks, defaultId) = bridge.status()
            if (ok) {
                val sel =
                    when {
                        _ui.value.selectedNotebookId.isNotBlank() &&
                            notebooks.any { it.id == _ui.value.selectedNotebookId } ->
                            _ui.value.selectedNotebookId
                        !defaultId.isNullOrBlank() -> defaultId
                        notebooks.isNotEmpty() -> notebooks.first().id
                        else -> ""
                    }
                _ui.update {
                    it.copy(
                        connected = true,
                        notebooks = notebooks,
                        selectedNotebookId = sel,
                        statusLine = "已连接电脑",
                    )
                }
                if (sel.isNotBlank()) refreshItems()
            } else {
                val ping = runCatching { bridge.ping() }.getOrNull()
                _ui.update {
                    it.copy(
                        connected = ping?.ok == true,
                        statusLine = if (ping?.ok == true) "已连接（ping）" else "未连通电脑服务",
                    )
                }
            }
        }
    }

    private suspend fun refreshItems() {
        val nb = _ui.value.selectedNotebookId
        if (nb.isBlank() || !_ui.value.connected) {
            _ui.update { it.copy(items = emptyList()) }
            return
        }
        runCatching { bridge.listItems(nb) }
            .onSuccess { list -> _ui.update { it.copy(items = list) } }
            .onFailure { e -> _ui.update { it.copy(statusLine = e.message ?: "拉条目失败") } }
    }

    fun createNotebook(name: String, templateId: String) {
        viewModelScope.launch {
            _ui.update { it.copy(busy = true) }
            runCatching { bridge.createNotebook(name, templateId) }
                .onSuccess { nb ->
                    _ui.update { it.copy(statusLine = "已创建记录本：${nb.name}", selectedNotebookId = nb.id) }
                    refreshConnection()
                }
                .onFailure { e -> _ui.update { it.copy(statusLine = "新建失败：${e.message}") } }
            _ui.update { it.copy(busy = false) }
        }
    }

    fun createItem(title: String, body: String) {
        viewModelScope.launch {
            val nb = _ui.value.selectedNotebookId
            if (nb.isBlank()) {
                _ui.update { it.copy(statusLine = "请先选择记录本") }
                return@launch
            }
            _ui.update { it.copy(busy = true) }
            runCatching { bridge.createItem(nb, title, body) }
                .onSuccess { item ->
                    _ui.update { it.copy(statusLine = "已创建条目：${item.title}", selectedItemId = item.id) }
                    refreshItems()
                }
                .onFailure { e -> _ui.update { it.copy(statusLine = "新建条目失败：${e.message}") } }
            _ui.update { it.copy(busy = false) }
        }
    }

    private fun targetLabel(): String {
        val id = _ui.value.selectedItemId
        if (id.isBlank()) return "新建条目"
        val t = _ui.value.items.find { it.id == id }?.title
        return if (t.isNullOrBlank()) "追加到已有条目" else "追加到：$t"
    }

    fun cacheText() {
        viewModelScope.launch {
            val text = _ui.value.text.trim()
            if (text.isEmpty()) {
                _ui.update { it.copy(statusLine = "请先输入内容") }
                return@launch
            }
            queueRepo.add(
                QueueItem(
                    kind = QueueKind.TEXT,
                    title = text.lineSequence().first().take(40),
                    text = text,
                    organize = true,
                    notebookId = _ui.value.selectedNotebookId,
                    itemId = _ui.value.selectedItemId,
                    targetLabel = targetLabel(),
                ),
            )
            _ui.update { it.copy(text = "", statusLine = "已加入待发送（本地缓存）") }
        }
    }

    fun sendTextNow(organize: Boolean) {
        viewModelScope.launch {
            val text = _ui.value.text.trim()
            if (text.isEmpty()) {
                _ui.update { it.copy(statusLine = "请先输入内容") }
                return@launch
            }
            if (!_ui.value.connected) {
                queueRepo.add(
                    QueueItem(
                        kind = QueueKind.TEXT,
                        title = text.lineSequence().first().take(40),
                        text = text,
                        organize = organize,
                        notebookId = _ui.value.selectedNotebookId,
                        itemId = _ui.value.selectedItemId,
                        targetLabel = targetLabel(),
                    ),
                )
                _ui.update { it.copy(text = "", statusLine = "未连通：已缓存到待发送") }
                return@launch
            }
            _ui.update { it.copy(busy = true, statusLine = if (organize) "发送并整理中…" else "写入收件箱…") }
            runCatching {
                bridge.sendText(
                    text = text,
                    organize = organize,
                    notebookId = _ui.value.selectedNotebookId.ifBlank { null },
                    itemId = _ui.value.selectedItemId.ifBlank { null },
                )
            }.onSuccess { r ->
                val msg =
                    buildString {
                        append(if (r.appended) "已追加" else "已写入")
                        if (r.title.isNotBlank()) append("：${r.title}")
                        else if (r.path.isNotBlank()) append("：${r.path}")
                        if (r.organized) append("（已 AI 整理）")
                        if (!organize) append("（收件箱）")
                    }
                _ui.update { it.copy(text = "", statusLine = msg) }
                loadRecent()
            }.onFailure { e ->
                queueRepo.add(
                    QueueItem(
                        kind = QueueKind.TEXT,
                        title = text.lineSequence().first().take(40),
                        text = text,
                        organize = organize,
                        notebookId = _ui.value.selectedNotebookId,
                        itemId = _ui.value.selectedItemId,
                        targetLabel = targetLabel(),
                        lastError = e.message.orEmpty(),
                    ),
                )
                _ui.update { it.copy(statusLine = "发送失败，已改存待发送：${e.message}") }
            }
            _ui.update { it.copy(busy = false) }
        }
    }

    fun startRecording() {
        if (recorder.isRecording) return
        recorder.start(_ui.value.audioFormat).fold(
            onSuccess = {
                _ui.update { it.copy(recording = true, recordSeconds = 0, voiceReady = false, statusLine = "录音中…") }
                lastVoiceB64 = ""
                lastVoiceMime = ""
                tickJob?.cancel()
                tickJob =
                    viewModelScope.launch {
                        var s = 0
                        while (isActive && recorder.isRecording) {
                            delay(1000)
                            s++
                            _ui.update { it.copy(recordSeconds = s) }
                        }
                    }
            },
            onFailure = { e -> _ui.update { it.copy(statusLine = "无法开始录音：${e.message}") } },
        )
    }

    fun stopRecording() {
        tickJob?.cancel()
        recorder.stop().fold(
            onSuccess = { clip: RecordedClip ->
                lastVoiceB64 = clip.base64
                lastVoiceMime = clip.mimeType
                lastVoiceLocalPath = clip.localPath
                _ui.update {
                    it.copy(
                        recording = false,
                        voiceReady = true,
                        statusLine = "录音完成，可发送到所选条目",
                    )
                }
            },
            onFailure = { e ->
                _ui.update { it.copy(recording = false, voiceReady = false, statusLine = "停止失败：${e.message}") }
            },
        )
    }

    fun cacheVoice() {
        viewModelScope.launch {
            if (lastVoiceB64.isBlank()) {
                _ui.update { it.copy(statusLine = "请先录音") }
                return@launch
            }
            val clientSourceId = java.util.UUID.randomUUID().toString()
            queueRepo.add(
                QueueItem(
                    clientSourceId = clientSourceId,
                    kind = QueueKind.VOICE,
                    title = "语音 ${_ui.value.recordSeconds}s",
                    audioBase64 = lastVoiceB64,
                    mimeType = lastVoiceMime.ifBlank { _ui.value.audioFormat.mimeType },
                    organize = true,
                    notebookId = _ui.value.selectedNotebookId,
                    itemId = _ui.value.selectedItemId,
                    targetLabel = targetLabel(),
                    localPath = lastVoiceLocalPath,
                ),
            )
            lastVoiceB64 = ""
            _ui.update { it.copy(voiceReady = false, statusLine = "语音已加入待发送（本地）") }
        }
    }

    fun sendVoiceNow(organize: Boolean) {
        viewModelScope.launch {
            if (lastVoiceB64.isBlank()) {
                _ui.update { it.copy(statusLine = "请先录音并停止") }
                return@launch
            }
            val b64 = lastVoiceB64
            val mime = lastVoiceMime.ifBlank { _ui.value.audioFormat.mimeType }
            val nb = _ui.value.selectedNotebookId
            val item = _ui.value.selectedItemId
            val clientSourceId = java.util.UUID.randomUUID().toString()
            if (!_ui.value.connected) {
                queueRepo.add(
                    QueueItem(
                        clientSourceId = clientSourceId,
                        kind = QueueKind.VOICE,
                        title = "语音",
                        audioBase64 = b64,
                        mimeType = mime,
                        organize = organize,
                        notebookId = nb,
                        itemId = item,
                        targetLabel = targetLabel(),
                        localPath = lastVoiceLocalPath,
                    ),
                )
                lastVoiceB64 = ""
                _ui.update { it.copy(voiceReady = false, statusLine = "未连通：语音已缓存") }
                return@launch
            }
            _ui.update {
                it.copy(
                    busy = true,
                    statusLine =
                        if (item.isNotBlank()) "发送语音到所选条目…"
                        else "发送语音…",
                )
            }
            runCatching {
                bridge.sendVoice(
                    audioBase64 = b64,
                    mimeType = mime,
                    organize = organize,
                    notebookId = nb.ifBlank { null },
                    itemId = item.ifBlank { null },
                    clientSourceId = clientSourceId,
                )
            }.onSuccess { r ->
                    val kept = lastVoiceLocalPath
                    lastVoiceB64 = ""
                    lastVoiceLocalPath = ""
                    rememberLocalSource(
                    kind = "voice",
                    preview = "phone-voice",
                    localPath = kept,
                    destPath = r.path,
                    itemTitle = r.title,
                    clientSourceId = r.clientSourceId.ifBlank { clientSourceId },
                )
                // App only reports transfer success; STT progress is desktop-only
                _ui.update {
                    it.copy(
                        voiceReady = false,
                        statusLine =
                            buildString {
                                append("传输成功")
                                if (r.appended) append("（已追加）")
                                if (r.title.isNotBlank()) append("：${r.title}")
                                append(" · 转写进度见电脑")
                            },
                    )
                }
                loadRecent()
            }.onFailure { e ->
                val err = e.message.orEmpty()
                    .replace(Regex("<[^>]+>"), " ")
                    .replace(Regex("\\s+"), " ")
                    .trim()
                    .take(200)
                queueRepo.add(
                    QueueItem(
                        clientSourceId = clientSourceId,
                        kind = QueueKind.VOICE,
                        title = "语音",
                        audioBase64 = b64,
                        mimeType = mime,
                        organize = organize,
                        notebookId = nb,
                        itemId = item,
                        targetLabel = targetLabel(),
                        localPath = lastVoiceLocalPath,
                        lastError = err,
                    ),
                )
                lastVoiceB64 = ""
                _ui.update {
                    it.copy(
                        voiceReady = false,
                        statusLine = "语音发送失败：${err.ifBlank { "未知错误" }}（已保留在待发送）",
                    )
                }
            }
            _ui.update { it.copy(busy = false) }
        }
    }

    fun setSelectedFiles(uris: List<Uri>) {
        val unique = distinctUriStrings(uris.map(Uri::toString)).map(Uri::parse)
        pendingFileUris = unique
        val label = if (unique.isEmpty()) "" else "已选 ${unique.size} 个文件"
        _ui.update {
            it.copy(
                selectedFilesLabel = label,
                statusLine = if (unique.isEmpty()) "未选择文件" else label,
            )
        }
        val app = getApplication<Application>()
        unique.forEach { uri ->
            runCatching {
                app.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
    }

    fun processSelectedFiles(organize: Boolean, sendNow: Boolean) {
        if (_ui.value.busy) return
        val uris = distinctUriStrings(pendingFileUris.map(Uri::toString)).map(Uri::parse)
        if (uris.isEmpty()) {
            _ui.update { it.copy(statusLine = "请先点「选择文件」") }
            return
        }
        pendingFileUris = emptyList()
        _ui.update { it.copy(busy = true, selectedFilesLabel = "", statusLine = "正在处理 ${uris.size} 个文件…") }
        viewModelScope.launch {
            var ok = 0
            var fail = 0
            enqueueFiles(uris, organize, sendNow) { succeeded ->
                if (succeeded) ok++ else fail++
            }
            if (ok == 0) {
                pendingFileUris = uris
            }
            _ui.update {
                it.copy(
                    busy = false,
                    selectedFilesLabel = if (ok == 0) "已选 ${uris.size} 个文件" else "",
                    statusLine = "文件处理完成：成功 $ok${if (fail > 0) "，失败 $fail" else ""}",
                )
            }
            if (sendNow) loadRecent()
        }
    }

    private suspend fun enqueueFiles(
        uris: List<Uri>,
        organize: Boolean,
        sendNow: Boolean,
        onResult: (Boolean) -> Unit,
    ) {
            val app = getApplication<Application>()
            val cr = app.contentResolver
            for (uri in distinctUriStrings(uris.map(Uri::toString)).map(Uri::parse)) {
                var queriedSize = -1L
                val name =
                    runCatching {
                        cr.query(uri, null, null, null, null)?.use { c ->
                            if (!c.moveToFirst()) return@use null
                            val sizeIdx = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
                            if (sizeIdx >= 0 && !c.isNull(sizeIdx)) queriedSize = c.getLong(sizeIdx)
                            val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                            if (idx >= 0) c.getString(idx) else null
                        }
                    }.getOrNull() ?: "file"
                val mime = cr.getType(uri) ?: "application/octet-stream"
                val bytes = runCatching { cr.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
                if (bytes == null) {
                    onResult(false)
                    continue
                }
                val originalSize = if (queriedSize > 0L) queriedSize else bytes.size.toLong()
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val localPath =
                    runCatching {
                        val dir = File(app.filesDir, "sources").also { it.mkdirs() }
                        val safe = name.replace(Regex("[\\/:*?\"<>|]"), "_")
                        val dest = File(dir, "${System.currentTimeMillis()}_$safe")
                        dest.writeBytes(bytes)
                        dest.absolutePath
                    }.getOrDefault("")
                val item =
                    QueueItem(
                        kind = QueueKind.FILE,
                        title = name,
                        fileName = name,
                        fileBase64 = b64,
                        mimeType = mime,
                        organize = organize,
                        notebookId = _ui.value.selectedNotebookId,
                        itemId = _ui.value.selectedItemId,
                        targetLabel = targetLabel(),
                        localPath = localPath,
                        originalUri = uri.toString(),
                        originalUriPersisted = cr.persistedUriPermissions.any { it.uri == uri && it.isReadPermission },
                        originalMimeType = mime,
                        originalDisplayName = name,
                        originalSize = originalSize,
                    )
                if (sendNow && _ui.value.connected) {
                    _ui.update { it.copy(busy = true, statusLine = "发送文件 $name …") }
                    runCatching {
                        bridge.sendFile(
                            fileBase64 = b64,
                            fileName = name,
                            mimeType = mime,
                            organize = organize,
                            notebookId = _ui.value.selectedNotebookId.ifBlank { null },
                            itemId = _ui.value.selectedItemId.ifBlank { null },
                            title = name,
                            clientSourceId = item.clientSourceId,
                        )
                    }.onSuccess { r ->
                        rememberLocalSource(
                            kind = "file",
                            preview = name,
                            localPath = localPath,
                            originalUri = item.originalUri,
                            originalUriPersisted = item.originalUriPersisted,
                            originalMimeType = item.originalMimeType,
                            originalDisplayName = item.originalDisplayName,
                            originalSize = item.originalSize,
                            destPath = r.path,
                            itemTitle = r.title,
                            clientSourceId = r.clientSourceId.ifBlank { item.clientSourceId },
                        )
                        _ui.update { it.copy(statusLine = "已发送：$name") }
                        onResult(true)
                    }.onFailure { e ->
                        queueRepo.add(item.copy(lastError = e.message.orEmpty()))
                        _ui.update { it.copy(statusLine = "文件发送失败，已加入待发送：$name · ${e.message}") }
                        onResult(true)
                    }
                } else {
                    queueRepo.add(item)
                    _ui.update { it.copy(statusLine = "文件已加入待发送：$name") }
                    onResult(true)
                }
            }
    }

    fun sendQueueIds(ids: Set<String>) {
        viewModelScope.launch {
            if (!_ui.value.connected) {
                _ui.update { it.copy(statusLine = "未连通，无法发送") }
                return@launch
            }
            val items = _ui.value.queue.filter { it.id in ids }
            if (items.isEmpty()) {
                _ui.update { it.copy(statusLine = "没有选中项") }
                return@launch
            }
            var ok = 0
            var fail = 0
            val errors = mutableListOf<String>()
            items.forEachIndexed { index, it ->
                _ui.update { st ->
                    st.copy(
                        busy = true,
                        sendProgress = "发送 ${index + 1}/${items.size} · ${it.title.ifBlank { it.kind.name }}",
                    )
                }
                val result =
                    runCatching {
                        when (it.kind) {
                            QueueKind.TEXT ->
                                bridge.sendText(
                                    it.text,
                                    it.organize,
                                    it.notebookId.ifBlank { null },
                                    it.itemId.ifBlank { null },
                                    source = "android-app-queue",
                                )
                            QueueKind.VOICE ->
                                bridge.sendVoice(
                                    it.audioBase64,
                                    it.mimeType.ifBlank { "audio/mp4" },
                                    it.organize,
                                    it.notebookId.ifBlank { null },
                                    it.itemId.ifBlank { null },
                                    it.clientSourceId,
                                )
                            QueueKind.FILE ->
                                bridge.sendFile(
                                    it.fileBase64,
                                    it.fileName,
                                    it.mimeType,
                                    it.organize,
                                    it.notebookId.ifBlank { null },
                                    it.itemId.ifBlank { null },
                                    it.title,
                                    it.clientSourceId,
                                )
                        }
                    }
                if (result.isSuccess) {
                    val response = result.getOrThrow()
                    if (it.kind == QueueKind.VOICE || it.kind == QueueKind.FILE) {
                        rememberLocalSource(
                            kind = if (it.kind == QueueKind.VOICE) "voice" else "file",
                            preview = if (it.kind == QueueKind.FILE) it.fileName else it.title,
                            localPath = it.localPath,
                            originalUri = it.originalUri,
                            originalUriPersisted = it.originalUriPersisted,
                            originalMimeType = it.originalMimeType,
                            originalDisplayName = it.originalDisplayName,
                            originalSize = it.originalSize,
                            destPath = response.path,
                            itemTitle = response.title,
                            clientSourceId = response.clientSourceId.ifBlank { it.clientSourceId },
                        )
                    }
                    ok++
                    queueRepo.remove(setOf(it.id))
                } else {
                    fail++
                    val msg = result.exceptionOrNull()?.message.orEmpty()
                    errors += msg
                    queueRepo.updateError(it.id, msg)
                }
            }
            val detail = errors.firstOrNull()?.let { "；原因示例：$it" }.orEmpty()
            _ui.update {
                it.copy(
                    busy = false,
                    sendProgress = "",
                    statusLine = "发送完成：成功 $ok${if (fail > 0) "，失败 $fail$detail" else ""}",
                )
            }
            loadRecent()
        }
    }

    fun deleteQueueToTrash(ids: Set<String>) {
        viewModelScope.launch { queueRepo.moveToTrash(ids) }
    }

    fun restoreTrash(ids: Set<String>) {
        viewModelScope.launch { queueRepo.restore(ids) }
    }

    fun purgeTrash(ids: Set<String>) {
        viewModelScope.launch { queueRepo.purge(ids) }
    }

    fun emptyTrash() {
        viewModelScope.launch { queueRepo.emptyTrash() }
    }

    fun loadRecent() {
        viewModelScope.launch {
            val local = localRecent.all()
            val hidden = localRecent.hiddenKeys()
            _ui.update { it.copy(localRecent = local, hiddenRecentKeys = hidden) }
            if (!_ui.value.connected) return@launch
            runCatching { bridge.recent() }
                .onSuccess { list -> _ui.update { it.copy(recent = list, localRecent = local, hiddenRecentKeys = hidden) } }
                .onFailure { e -> _ui.update { it.copy(statusLine = "最近写入刷新失败：${e.message}") } }
        }
    }

    private suspend fun rememberLocalSource(
        kind: String,
        preview: String,
        localPath: String,
        originalUri: String = "",
        originalUriPersisted: Boolean = false,
        originalMimeType: String = "",
        originalDisplayName: String = "",
        originalSize: Long = 0L,
        destPath: String = "",
        itemTitle: String = "",
        clientSourceId: String = "",
    ) {
        if (localPath.isBlank() && originalUri.isBlank()) return
        localRecent.add(
            LocalRecentEntry(
                kind = kind,
                clientSourceId = clientSourceId,
                title = preview,
                preview = preview,
                localPath = localPath,
                originalUri = originalUri,
                originalUriPersisted = originalUriPersisted,
                originalMimeType = originalMimeType,
                originalDisplayName = originalDisplayName,
                originalSize = originalSize,
                destPath = destPath,
                notebookName = _ui.value.notebooks.find { it.id == _ui.value.selectedNotebookId }?.name.orEmpty(),
                itemTitle = itemTitle.ifBlank {
                    _ui.value.items.find { it.id == _ui.value.selectedItemId }?.title.orEmpty()
                },
            ),
        )
    }

    fun openRecentFile(clientSourceId: String, kind: String, preview: String, destPath: String) {
        viewModelScope.launch {
            val entry = localRecent.findEntry(clientSourceId, kind, preview, destPath)
            val hasLocal =
                entry != null &&
                    entry.localPath.isNotBlank() &&
                    !entry.localCopyDeleted &&
                    java.io.File(entry.localPath).exists()
            if (hasLocal) {
                openLocalSource(clientSourceId, kind, preview, destPath)
                return@launch
            }
            if (entry?.originalUri?.isNotBlank() == true) {
                openOriginalLocation(clientSourceId, kind, preview, destPath)
                return@launch
            }
            // Fall back to local open attempt (covers voice copies still on disk lookup path).
            openLocalSource(clientSourceId, kind, preview, destPath)
        }
    }

    fun openOriginalLocation(clientSourceId: String, kind: String, preview: String, destPath: String) {
        viewModelScope.launch {
            val entry = localRecent.findEntry(clientSourceId, kind, preview, destPath)
            val source = entry ?: run {
                _ui.update { it.copy(statusLine = "未记录原始文件位置") }
                return@launch
            }
            val raw = source.originalUri
            if (raw.isBlank()) {
                _ui.update { it.copy(statusLine = "未记录原始文件位置") }
                return@launch
            }
            val uri = Uri.parse(raw)
            if (!originalUriMatchesStored(uri, source)) {
                _ui.update { it.copy(statusLine = "原始文件信息不匹配，已阻止打开；可打开手机副本") }
                return@launch
            }
            if (tryOpenOriginalLocation(uri, source.originalMimeType)) {
                _ui.update { it.copy(statusLine = "已尝试打开原文件位置") }
            } else {
                _ui.update { it.copy(statusLine = "系统不允许打开原文件位置，可改用手机副本") }
            }
        }
    }

    /** Conservative check: only reject when both sides have metadata and they disagree. */
    private fun originalUriMatchesStored(uri: Uri, source: LocalRecentEntry): Boolean {
        val app = getApplication<Application>()
        val cr = app.contentResolver
        val currentMime = runCatching { cr.getType(uri) }.getOrNull().orEmpty()
        val meta =
            runCatching {
                cr.query(uri, null, null, null, null)?.use { c ->
                    if (!c.moveToFirst()) return@use null
                    val nameIdx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
                    val name = if (nameIdx >= 0) c.getString(nameIdx).orEmpty() else ""
                    val size = if (sizeIdx >= 0 && !c.isNull(sizeIdx)) c.getLong(sizeIdx) else -1L
                    name to size
                }
            }.getOrNull()
        val (currentName, currentSize) = meta ?: ("" to -1L)
        return originalSourceMetadataMatches(
            stored =
                OriginalSourceMetadata(
                    displayName = source.originalDisplayName,
                    size = source.originalSize,
                    mimeType = source.originalMimeType,
                ),
            current =
                OriginalSourceMetadata(
                    displayName = currentName,
                    size = currentSize,
                    mimeType = currentMime,
                ),
        )
    }

    private fun tryOpenOriginalLocation(uri: Uri, mimeType: String): Boolean {
        val app = getApplication<Application>()
        val openOriginal =
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType.ifBlank { app.contentResolver.getType(uri) ?: "*/*" })
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        val chooser =
            Intent.createChooser(openOriginal, "打开原始文件").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        if (runCatching { app.startActivity(chooser) }.isSuccess) return true
        return runCatching { app.startActivity(buildOriginalFolderIntent(uri)) }.isSuccess
    }

    private fun buildOriginalFolderIntent(uri: Uri): Intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            putExtra("android.provider.extra.SHOW_ADVANCED", true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            parentDocumentUri(uri)?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) }
        }

    private fun parentDocumentUri(uri: Uri): Uri? =
        runCatching {
            if (!DocumentsContract.isDocumentUri(getApplication<Application>(), uri)) return null
            val documentId = DocumentsContract.getDocumentId(uri)
            val parentId = documentId.substringBeforeLast('/', missingDelimiterValue = documentId)
            if (parentId == documentId) return null
            DocumentsContract.buildDocumentUriUsingTree(uri, parentId)
        }.getOrNull()

    fun deleteRecentRecords(rows: List<RecentDto>, removeQueueReferences: Boolean = false) {
        viewModelScope.launch {
            val localIds = rows.mapNotNull { row ->
                val what = row.sourceLabel.ifBlank { row.preview.ifBlank { row.title } }
                com.gaomu.suji.workshop.data.repo.matchLocalRecentEntry(
                    _ui.value.localRecent,
                    row.clientSourceId,
                    row.kind,
                    what,
                    row.path,
                )?.id
            }.toSet()
            if (localIds.isNotEmpty()) {
                deleteRecentCopiesInternal(localIds, removeMetadata = true, removeQueueReferences = removeQueueReferences)
            }
            localRecent.hideRows(rows)
            val refreshedLocal = localRecent.all()
            val hiddenRecentKeys = localRecent.hiddenKeys()
            _ui.update {
                it.copy(
                    localRecent = refreshedLocal,
                    hiddenRecentKeys = hiddenRecentKeys,
                    statusLine = "已移除手机本地最近记录 ${rows.size} 条，不影响电脑 vault",
                )
            }
        }
    }

    fun deleteRecentCopies(ids: Set<String>, removeMetadata: Boolean, removeQueueReferences: Boolean = false) {
        viewModelScope.launch {
            deleteRecentCopiesInternal(ids, removeMetadata, removeQueueReferences)
        }
    }

    private suspend fun deleteRecentCopiesInternal(ids: Set<String>, removeMetadata: Boolean, removeQueueReferences: Boolean = false) {
            val entries = _ui.value.localRecent.filter { it.id in ids }
            val queueMatches = (_ui.value.queue + _ui.value.trash).filter { item ->
                entries.any { entry ->
                    (entry.clientSourceId.isNotBlank() && entry.clientSourceId == item.clientSourceId) ||
                        (entry.localPath.isNotBlank() && entry.localPath == item.localPath) ||
                        (entry.originalUri.isNotBlank() && entry.originalUri == item.originalUri)
                }
            }
            if (queueMatches.isNotEmpty() && !removeQueueReferences) {
                _ui.update { it.copy(statusLine = "所选来源仍在待发送或垃圾箱中，已取消删除") }
                return
            }
            if (removeQueueReferences) {
                queueRepo.remove(queueMatches.filter { it.id in _ui.value.queue.map { q -> q.id } }.map { it.id }.toSet())
                queueRepo.purge(queueMatches.filter { it.id in _ui.value.trash.map { t -> t.id } }.map { it.id }.toSet())
            }
            var deleted = 0
            var failed = 0
            val completedIds = mutableSetOf<String>()
            entries.forEach { entry ->
                val path = entry.localPath
                if (path.isBlank()) {
                    completedIds += entry.id
                    return@forEach
                }
                val file = File(path)
                val app = getApplication<Application>()
                when {
                    !file.exists() -> completedIds += entry.id
                    !isAppOwnedSource(file, app.filesDir, File(app.cacheDir, "sources")) -> failed++
                    file.delete() -> {
                        deleted++
                        completedIds += entry.id
                    }
                    else -> failed++
                }
            }
            if (removeMetadata) {
                localRecent.hide(entries.filter { it.id in completedIds })
                localRecent.remove(completedIds)
            } else {
                localRecent.markCopyDeleted(completedIds)
            }
            val refreshedLocal = localRecent.all()
            val hiddenRecentKeys = localRecent.hiddenKeys()
            if (removeMetadata) {
                val remainingUris = refreshedLocal.map { it.originalUri }.filter { it.isNotBlank() }.toSet()
                val resolver = getApplication<Application>().contentResolver
                entries.filter { it.id in completedIds && it.originalUriPersisted && it.originalUri !in remainingUris }
                    .forEach { entry ->
                        runCatching {
                            resolver.releasePersistableUriPermission(
                                Uri.parse(entry.originalUri),
                                Intent.FLAG_GRANT_READ_URI_PERMISSION,
                            )
                        }
                    }
            }
            _ui.update {
                it.copy(
                    localRecent = refreshedLocal,
                    hiddenRecentKeys = hiddenRecentKeys,
                    statusLine = "已删除手机副本 $deleted 个${if (removeMetadata) "，并移除对应最近记录" else "，最近记录已保留"}${if (failed > 0) "；失败 $failed 个" else ""}",
                )
            }
    }

    /** Open phone-local original file from 最近. */
    fun openLocalSource(clientSourceId: String, kind: String, preview: String, destPath: String) {
        viewModelScope.launch {
            val path =
                localRecent.findLocalPath(clientSourceId, kind, preview, destPath)
                    ?: run {
                        _ui.update { it.copy(statusLine = "找不到手机本地源文件（可能已清理）") }
                        return@launch
                    }
            val app = getApplication<Application>()
            val file = File(path)
            if (file.exists() && !isAppOwnedSource(file, app.filesDir, File(app.cacheDir, "sources"))) {
                _ui.update { it.copy(statusLine = "拒绝打开非 App 管理的本地路径") }
                return@launch
            }
            if (!file.exists()) {
                if (path.startsWith("content://")) {
                    try {
                        val intent =
                            Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(android.net.Uri.parse(path), null)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                        app.startActivity(Intent.createChooser(intent, "打开源文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        return@launch
                    } catch (e: Exception) {
                        _ui.update { it.copy(statusLine = "无法打开：$path") }
                        return@launch
                    }
                }
                _ui.update { it.copy(statusLine = "本地文件不存在：$path") }
                return@launch
            }
            try {
                val uri =
                    FileProvider.getUriForFile(
                        app,
                        app.packageName + ".fileprovider",
                        file,
                    )
                val mime =
                    app.contentResolver.getType(uri)
                        ?: when {
                            path.endsWith(".m4a", true) || path.endsWith(".mp3", true) ||
                                path.endsWith(".wav", true) || path.endsWith(".ogg", true) -> "audio/*"
                            path.endsWith(".mp4", true) || path.endsWith(".mov", true) ||
                                path.endsWith(".mkv", true) || path.endsWith(".webm", true) -> "video/*"
                            path.endsWith(".jpg", true) || path.endsWith(".jpeg", true) ||
                                path.endsWith(".png", true) || path.endsWith(".gif", true) ||
                                path.endsWith(".webp", true) -> "image/*"
                            path.endsWith(".pdf", true) -> "application/pdf"
                            else -> "*/*"
                        }
                val intent =
                    Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, mime)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                app.startActivity(Intent.createChooser(intent, "打开源文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                _ui.update { it.copy(statusLine = "打开失败：${e.message}") }
            }
        }
    }


}
