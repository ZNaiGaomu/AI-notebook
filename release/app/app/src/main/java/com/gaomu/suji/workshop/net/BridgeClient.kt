package com.gaomu.suji.workshop.net

import com.gaomu.suji.workshop.data.prefs.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

@Serializable
data class NotebookDto(val id: String, val name: String)

@Serializable
data class ItemDto(val id: String, val title: String = "")

@Serializable
data class RecentDto(
    val title: String = "",
    val preview: String = "",
    val path: String = "",
    val organized: Boolean = false,
    val at: String = "",
    val notebookId: String = "",
    val notebookName: String = "",
    val itemId: String = "",
    val itemTitle: String = "",
    val kind: String = "",
    val sourceLabel: String = "",
    val sourcePath: String = "",
    val attachmentId: String = "",
    val clientSourceId: String = "",
)

data class ApiResult(
    val ok: Boolean,
    val message: String = "",
    val title: String = "",
    val path: String = "",
    val organized: Boolean = false,
    val appended: Boolean = false,
    val warning: String = "",
    val transcript: String = "",
    val jobId: String = "",
    val transcribeStatus: String = "",
    val clientSourceId: String = "",
    val raw: String = "",
)

data class VoiceJobDto(
    val id: String = "",
    val status: String = "",
    val progress: String = "",
    val transcript: String = "",
    val warning: String = "",
    val path: String = "",
    val itemId: String = "",
    val title: String = "",
)

class BridgeClient(
    private val settingsRepo: SettingsRepository,
    private val client: OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build(),
) {
    private val json =
        Json {
            ignoreUnknownKeys = true
            isLenient = true
        }
    private val mediaJson = "application/json; charset=utf-8".toMediaType()

    suspend fun ping(): ApiResult =
        get("/api/ping") { body ->
            ApiResult(ok = body.bool("ok") || body.bool("pong"), message = "pong", raw = body.toString())
        }

    suspend fun status(): Triple<Boolean, List<NotebookDto>, String?> {
        val s = settingsRepo.settingsFlow.first()
        if (!s.isConfigured) return Triple(false, emptyList(), null)
        return withContext(Dispatchers.IO) {
            try {
                val req =
                    Request.Builder()
                        .url(url(s.baseUrl, "/api/status", s.token))
                        .header("X-Bridge-Token", s.token)
                        .get()
                        .build()
                client.newCall(req).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
                    if (!resp.isSuccessful || root == null) {
                        return@withContext Triple(false, emptyList(), null)
                    }
                    val ok = root["ok"]?.jsonPrimitive?.booleanOrNull != false
                    val notebooks =
                        root["notebooks"]?.jsonArray?.mapNotNull { el ->
                            val o = el.jsonObject
                            val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                            val name = o["name"]?.jsonPrimitive?.contentOrNull ?: id
                            NotebookDto(id, name)
                        } ?: emptyList()
                    val defaultId = root["notebookId"]?.jsonPrimitive?.contentOrNull
                    Triple(ok, notebooks, defaultId)
                }
            } catch (_: Exception) {
                Triple(false, emptyList(), null)
            }
        }
    }

    suspend fun listNotebooks(): List<NotebookDto> {
        val s = settingsRepo.settingsFlow.first()
        requireConfigured(s.baseUrl, s.token)
        return withContext(Dispatchers.IO) {
            val req =
                Request.Builder()
                    .url(url(s.baseUrl, "/api/notebooks", s.token))
                    .header("X-Bridge-Token", s.token)
                    .get()
                    .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val root = json.parseToJsonElement(text).jsonObject
                if (!resp.isSuccessful) error(root.str("error") ?: "HTTP ${resp.code}")
                root["notebooks"]?.jsonArray?.mapNotNull { el ->
                    val o = el.jsonObject
                    NotebookDto(
                        id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        name = o["name"]?.jsonPrimitive?.contentOrNull ?: "",
                    )
                } ?: emptyList()
            }
        }
    }

    suspend fun createNotebook(name: String, templateId: String): NotebookDto {
        val body =
            buildJsonObject {
                put("name", name)
                put("templateId", templateId)
            }
        return postJson("/api/notebooks", body) { root ->
            val nb = root["notebook"]?.jsonObject
            NotebookDto(
                id = nb?.get("id")?.jsonPrimitive?.contentOrNull
                    ?: root["defaultId"]?.jsonPrimitive?.contentOrNull
                    ?: error("无 notebook id"),
                name = nb?.get("name")?.jsonPrimitive?.contentOrNull ?: name,
            )
        }
    }

    suspend fun setDefaultNotebook(notebookId: String) {
        postJson("/api/notebook", buildJsonObject { put("notebook_id", notebookId) }) { it }
    }

    suspend fun listItems(notebookId: String): List<ItemDto> {
        val s = settingsRepo.settingsFlow.first()
        requireConfigured(s.baseUrl, s.token)
        return withContext(Dispatchers.IO) {
            val path = "/api/items?notebook_id=${android.net.Uri.encode(notebookId)}"
            val req =
                Request.Builder()
                    .url(url(s.baseUrl, path, s.token))
                    .header("X-Bridge-Token", s.token)
                    .get()
                    .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val root = json.parseToJsonElement(text).jsonObject
                if (!resp.isSuccessful) error(root.str("error") ?: "HTTP ${resp.code}")
                root["items"]?.jsonArray?.mapNotNull { el ->
                    val o = el.jsonObject
                    ItemDto(
                        id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        title = o["title"]?.jsonPrimitive?.contentOrNull ?: "未命名",
                    )
                } ?: emptyList()
            }
        }
    }

    suspend fun createItem(notebookId: String, title: String, body: String = ""): ItemDto {
        val payload =
            buildJsonObject {
                put("notebook_id", notebookId)
                put("title", title)
                put("body", body)
                put("capturedAt", System.currentTimeMillis())
            }
        return postJson("/api/items", payload) { root ->
            val it = root["item"]?.jsonObject
            ItemDto(
                id = it?.get("id")?.jsonPrimitive?.contentOrNull ?: error("无 item id"),
                title = it["title"]?.jsonPrimitive?.contentOrNull ?: title,
            )
        }
    }

    suspend fun sendText(
        text: String,
        organize: Boolean,
        notebookId: String?,
        itemId: String?,
        source: String = "android-app",
    ): ApiResult {
        val payload =
            buildJsonObject {
                put("text", text)
                put("organize", organize)
                put("source", source)
                put("capturedAt", System.currentTimeMillis())
                if (!notebookId.isNullOrBlank()) put("notebook_id", notebookId)
                if (!itemId.isNullOrBlank()) put("item_id", itemId)
            }
        return postJson("/api/text", payload) { root ->
            ApiResult(
                ok = root.bool("ok"),
                message = root.str("error").orEmpty(),
                title = root.str("title").orEmpty(),
                path = root.str("path").orEmpty(),
                organized = root.bool("organized"),
                appended = root.bool("appended"),
                warning = root.str("warning").orEmpty(),
                transcript = root.str("transcript").orEmpty(),
                jobId = root.str("jobId").orEmpty(),
                transcribeStatus = root.str("transcribeStatus").orEmpty(),
                raw = root.toString(),
            )
        }
    }

    suspend fun sendVoice(
        audioBase64: String,
        mimeType: String,
        organize: Boolean,
        notebookId: String?,
        itemId: String?,
        clientSourceId: String = "",
    ): ApiResult {
        val payload =
            buildJsonObject {
                put("audioBase64", audioBase64)
                put("mimeType", mimeType)
                put("organize", organize)
                put("source", "android-app-voice")
                put("clientSourceId", clientSourceId)
                put("capturedAt", System.currentTimeMillis())
                if (!notebookId.isNullOrBlank()) put("notebook_id", notebookId)
                if (!itemId.isNullOrBlank()) put("item_id", itemId)
            }
        return postJson("/api/voice", payload) { root ->
            ApiResult(
                ok = root.bool("ok"),
                message = root.str("error").orEmpty().ifBlank { root.str("message").orEmpty() },
                title = root.str("title").orEmpty(),
                path = root.str("path").orEmpty(),
                organized = root.bool("organized"),
                appended = root.bool("appended"),
                warning = root.str("warning").orEmpty(),
                transcript = root.str("transcript").orEmpty(),
                jobId = root.str("jobId").orEmpty(),
                transcribeStatus = root.str("transcribeStatus").orEmpty(),
                clientSourceId = root.str("clientSourceId").orEmpty().ifBlank { clientSourceId },
                raw = root.toString(),
            )
        }
    }

    suspend fun voiceJob(jobId: String): VoiceJobDto {
        val s = settingsRepo.settingsFlow.first()
        requireConfigured(s.baseUrl, s.token)
        return withContext(Dispatchers.IO) {
            val path = "/api/voice-job?id=${android.net.Uri.encode(jobId)}"
            val req =
                Request.Builder()
                    .url(url(s.baseUrl, path, s.token))
                    .header("X-Bridge-Token", s.token)
                    .get()
                    .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val root = json.parseToJsonElement(text).jsonObject
                if (!resp.isSuccessful || root["ok"]?.jsonPrimitive?.booleanOrNull == false) {
                    error(root.str("error") ?: "HTTP ${resp.code}")
                }
                val job = root["job"]?.jsonObject ?: error("无 job")
                VoiceJobDto(
                    id = job["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    status = job["status"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    progress = job["progress"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    transcript = job["transcript"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    warning = job["warning"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    path = job["path"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    itemId = job["itemId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    title = job["title"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                )
            }
        }
    }

    suspend fun sendFile(
        fileBase64: String,
        fileName: String,
        mimeType: String,
        organize: Boolean,
        notebookId: String?,
        itemId: String?,
        title: String? = null,
        clientSourceId: String = "",
    ): ApiResult {
        val payload =
            buildJsonObject {
                put("fileBase64", fileBase64)
                put("fileName", fileName)
                put("mimeType", mimeType)
                put("organize", organize)
                put("source", "android-app-file")
                put("clientSourceId", clientSourceId)
                put("capturedAt", System.currentTimeMillis())
                if (!title.isNullOrBlank()) put("title", title)
                if (!notebookId.isNullOrBlank()) put("notebook_id", notebookId)
                if (!itemId.isNullOrBlank()) put("item_id", itemId)
            }
        return postJson("/api/file", payload) { root ->
            ApiResult(
                ok = root.bool("ok"),
                message = root.str("error").orEmpty(),
                title = root.str("title").orEmpty(),
                path = root.str("path").orEmpty(),
                organized = root.bool("organized"),
                appended = root.bool("appended"),
                warning = root.str("warning").orEmpty(),
                transcript = root.str("transcript").orEmpty(),
                clientSourceId = root.str("clientSourceId").orEmpty().ifBlank { clientSourceId },
                raw = root.toString(),
            )
        }
    }

    suspend fun recent(): List<RecentDto> {
        val s = settingsRepo.settingsFlow.first()
        requireConfigured(s.baseUrl, s.token)
        return withContext(Dispatchers.IO) {
            val req =
                Request.Builder()
                    .url(url(s.baseUrl, "/api/recent", s.token))
                    .header("X-Bridge-Token", s.token)
                    .get()
                    .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val root = json.parseToJsonElement(text).jsonObject
                if (!resp.isSuccessful) error(root.str("error") ?: "HTTP ${resp.code}")
                root["items"]?.jsonArray?.map { el ->
                    val o = el.jsonObject
                    RecentDto(
                        title = o["title"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        preview = o["preview"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        path = o["path"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        organized = o["organized"]?.jsonPrimitive?.booleanOrNull == true,
                        at = o["at"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        notebookId = o["notebookId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        notebookName = o["notebookName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        itemId = o["itemId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        itemTitle = o["itemTitle"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        kind = o["kind"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        sourceLabel = o["sourceLabel"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        sourcePath = o["sourcePath"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        attachmentId = o["attachmentId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        clientSourceId = o["clientSourceId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    )
                } ?: emptyList()
            }
        }
    }

    private suspend fun <T> get(path: String, map: (JsonObject) -> T): T {
        val s = settingsRepo.settingsFlow.first()
        requireConfigured(s.baseUrl, s.token)
        return withContext(Dispatchers.IO) {
            val req =
                Request.Builder()
                    .url(url(s.baseUrl, path, s.token))
                    .header("X-Bridge-Token", s.token)
                    .get()
                    .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrElse {
                    error("响应不是 JSON（HTTP ${resp.code}）")
                }
                if (!resp.isSuccessful) error(root.str("error") ?: "HTTP ${resp.code}")
                map(root)
            }
        }
    }

    private suspend fun <T> postJson(path: String, body: JsonObject, map: (JsonObject) -> T): T {
        val s = settingsRepo.settingsFlow.first()
        requireConfigured(s.baseUrl, s.token)
        return withContext(Dispatchers.IO) {
            val req =
                Request.Builder()
                    .url(url(s.baseUrl, path, s.token))
                    .header("X-Bridge-Token", s.token)
                    .header("Content-Type", "application/json")
                    .post(body.toString().toRequestBody(mediaJson))
                    .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrElse {
                    error("响应不是 JSON（HTTP ${resp.code}）: ${text.take(120)}")
                }
                val okFlag = root["ok"]?.jsonPrimitive?.booleanOrNull
                if (!resp.isSuccessful || okFlag == false) {
                    error(root.str("error") ?: "HTTP ${resp.code}")
                }
                map(root)
            }
        }
    }

    private fun requireConfigured(baseUrl: String, token: String) {
        if (baseUrl.isBlank() || token.isBlank()) {
            error("尚未配置电脑链接，请先在设置里粘贴或扫码")
        }
    }

    private fun url(baseUrl: String, path: String, token: String): String {
        val base = baseUrl.trimEnd('/')
        val p = if (path.startsWith("/")) path else "/$path"
        val joiner = if (p.contains("?")) "&" else "?"
        return "$base$p${joiner}t=${android.net.Uri.encode(token)}"
    }

    private fun JsonObject.bool(key: String): Boolean =
        this[key]?.jsonPrimitive?.booleanOrNull == true

    private fun JsonObject.str(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull
}
