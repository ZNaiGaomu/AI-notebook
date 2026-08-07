package com.gaomu.suji.workshop.data.repo

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

@Serializable
enum class QueueKind { TEXT, VOICE, FILE }

@Serializable
data class QueueItem(
    val id: String = UUID.randomUUID().toString(),
    val clientSourceId: String = UUID.randomUUID().toString(),
    val kind: QueueKind,
    val title: String = "",
    val text: String = "",
    val audioBase64: String = "",
    val fileBase64: String = "",
    val fileName: String = "",
    val mimeType: String = "",
    val organize: Boolean = true,
    val notebookId: String = "",
    val itemId: String = "",
    val targetLabel: String = "",
    val createdAt: Long = System.currentTimeMillis(),
    val trashedAt: Long = 0L,
    val lastError: String = "",
    /** App-private durable copy used by 打开手机副本. */
    val localPath: String = "",
    /** Original Storage Access Framework URI; opened but never deleted by the app. */
    val originalUri: String = "",
    val originalUriPersisted: Boolean = false,
    val originalMimeType: String = "",
    val originalDisplayName: String = "",
    /** Size of the original source at capture time; 0 means unknown/legacy. */
    val originalSize: Long = 0L,
)

class QueueRepository(context: Context) {
    private val dir = File(context.filesDir, "queue").also { it.mkdirs() }
    private val queueFile = File(dir, "queue.json")
    private val trashFile = File(dir, "trash.json")
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }

    private val _queue = MutableStateFlow<List<QueueItem>>(emptyList())
    private val _trash = MutableStateFlow<List<QueueItem>>(emptyList())
    val queue: StateFlow<List<QueueItem>> = _queue.asStateFlow()
    val trash: StateFlow<List<QueueItem>> = _trash.asStateFlow()

    private val trashTtlMs = 30L * 24 * 60 * 60 * 1000

    suspend fun load() =
        withContext(Dispatchers.IO) {
            _queue.value = readList(queueFile)
            val t = readList(trashFile).filter { System.currentTimeMillis() - it.trashedAt <= trashTtlMs }
            _trash.value = t
            writeList(trashFile, t)
        }

    /** Move queue items older than retentionDays into trash. 0 = permanent (no-op). */
    suspend fun applyRetention(retentionDays: Int) =
        withContext(Dispatchers.IO) {
            if (retentionDays <= 0) return@withContext
            val ms = retentionDays.toLong() * 24 * 60 * 60 * 1000
            val now = System.currentTimeMillis()
            val keep = mutableListOf<QueueItem>()
            val move = mutableListOf<QueueItem>()
            for (it in _queue.value) {
                if (now - it.createdAt > ms) move += it.copy(trashedAt = now) else keep += it
            }
            if (move.isEmpty()) return@withContext
            _queue.value = keep
            _trash.value = move + _trash.value
            writeList(queueFile, keep)
            writeList(trashFile, _trash.value)
        }

    suspend fun add(item: QueueItem) =
        withContext(Dispatchers.IO) {
            val next = listOf(item) + _queue.value
            _queue.value = next
            writeList(queueFile, next)
        }

    suspend fun updateError(id: String, error: String) =
        withContext(Dispatchers.IO) {
            val next = _queue.value.map { if (it.id == id) it.copy(lastError = error) else it }
            _queue.value = next
            writeList(queueFile, next)
        }

    suspend fun remove(ids: Set<String>) =
        withContext(Dispatchers.IO) {
            val next = _queue.value.filterNot { it.id in ids }
            _queue.value = next
            writeList(queueFile, next)
        }

    suspend fun moveToTrash(ids: Set<String>) =
        withContext(Dispatchers.IO) {
            val moving = _queue.value.filter { it.id in ids }.map { it.copy(trashedAt = System.currentTimeMillis()) }
            val nextQ = _queue.value.filterNot { it.id in ids }
            val nextT = moving + _trash.value
            _queue.value = nextQ
            _trash.value = nextT
            writeList(queueFile, nextQ)
            writeList(trashFile, nextT)
        }

    suspend fun restore(ids: Set<String>) =
        withContext(Dispatchers.IO) {
            val restoring = _trash.value.filter { it.id in ids }.map { it.copy(trashedAt = 0L, lastError = "") }
            val nextT = _trash.value.filterNot { it.id in ids }
            val nextQ = restoring + _queue.value
            _trash.value = nextT
            _queue.value = nextQ
            writeList(trashFile, nextT)
            writeList(queueFile, nextQ)
        }

    suspend fun purge(ids: Set<String>) =
        withContext(Dispatchers.IO) {
            val nextT = _trash.value.filterNot { it.id in ids }
            _trash.value = nextT
            writeList(trashFile, nextT)
        }

    suspend fun emptyTrash() =
        withContext(Dispatchers.IO) {
            _trash.value = emptyList()
            writeList(trashFile, emptyList())
        }

    private fun readList(file: File): List<QueueItem> {
        if (!file.exists()) return emptyList()
        return runCatching { json.decodeFromString<List<QueueItem>>(file.readText()) }.getOrDefault(emptyList())
    }

    private fun writeList(file: File, items: List<QueueItem>) {
        file.writeText(json.encodeToString(items))
    }
}
