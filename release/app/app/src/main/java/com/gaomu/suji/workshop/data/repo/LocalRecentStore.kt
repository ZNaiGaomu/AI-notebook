package com.gaomu.suji.workshop.data.repo

import android.content.Context
import com.gaomu.suji.workshop.net.RecentDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

@Serializable
data class LocalRecentEntry(
    val id: String =
        java.util.UUID.randomUUID().toString(),
    val clientSourceId: String = "",
    val kind: String = "",
    val title: String = "",
    val preview: String = "",
    val localPath: String = "",
    val originalUri: String = "",
    val originalUriPersisted: Boolean = false,
    val originalMimeType: String = "",
    val originalDisplayName: String = "",
    /** Size of the original source at capture time; 0 means unknown/legacy. */
    val originalSize: Long = 0L,
    val localCopyDeleted: Boolean = false,
    val destPath: String = "",
    val notebookName: String = "",
    val itemTitle: String = "",
    val at: Long = System.currentTimeMillis(),
)

/** Phone-side recent with local source paths (merge with server /api/recent). */
class LocalRecentStore(context: Context) {
    private val file = File(context.filesDir, "local_recent.json")
    private val hiddenFile = File(context.filesDir, "hidden_recent.json")
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }
    private val max = 80

    suspend fun add(entry: LocalRecentEntry) =
        withContext(Dispatchers.IO) {
            val cur = loadUnlocked()
            val next =
                (listOf(entry) + cur.filterNot {
                    entry.clientSourceId.isNotBlank() && it.clientSourceId == entry.clientSourceId
                }).take(max)
            file.writeText(json.encodeToString(next))
        }

    suspend fun all(): List<LocalRecentEntry> =
        withContext(Dispatchers.IO) { loadUnlocked() }

    suspend fun findEntry(
        clientSourceId: String,
        kind: String,
        preview: String,
        destPath: String,
    ): LocalRecentEntry? =
        withContext(Dispatchers.IO) {
            val list = loadUnlocked()
            findEntryUnlocked(list, clientSourceId, kind, preview, destPath)
        }

    suspend fun findLocalPath(
        clientSourceId: String,
        kind: String,
        preview: String,
        destPath: String,
    ): String? = findEntry(clientSourceId, kind, preview, destPath)?.localPath

    suspend fun markCopyDeleted(ids: Set<String>) =
        withContext(Dispatchers.IO) {
            val next = loadUnlocked().map { entry ->
                if (entry.id in ids) entry.copy(localPath = "", localCopyDeleted = true) else entry
            }
            file.writeText(json.encodeToString(next))
        }

    suspend fun hiddenKeys(): Set<String> =
        withContext(Dispatchers.IO) { loadHiddenUnlocked() }

    suspend fun hide(entries: List<LocalRecentEntry>) =
        withContext(Dispatchers.IO) {
            val next = loadHiddenUnlocked() + entries.mapNotNull(::stableKey)
            hiddenFile.writeText(json.encodeToString(next))
        }

    suspend fun hideRows(rows: List<RecentDto>) =
        withContext(Dispatchers.IO) {
            val next = loadHiddenUnlocked() + rows.mapNotNull(::stableKey)
            hiddenFile.writeText(json.encodeToString(next))
        }

    suspend fun remove(ids: Set<String>) =
        withContext(Dispatchers.IO) {
            val next = loadUnlocked().filterNot { it.id in ids }
            file.writeText(json.encodeToString(next))
        }

    private fun findEntryUnlocked(
        list: List<LocalRecentEntry>,
        clientSourceId: String,
        kind: String,
        preview: String,
        destPath: String,
    ): LocalRecentEntry? = matchLocalRecentEntry(list, clientSourceId, kind, preview, destPath)

    private fun stableKey(entry: LocalRecentEntry): String? =
        when {
            entry.clientSourceId.isNotBlank() -> "client:${entry.clientSourceId}"
            entry.destPath.isNotBlank() -> "path:${entry.kind}:${entry.destPath}"
            else -> null
        }

    private fun stableKey(row: RecentDto): String? =
        when {
            row.clientSourceId.isNotBlank() -> "client:${row.clientSourceId}"
            row.path.isNotBlank() -> "path:${row.kind}:${row.path}"
            else -> null
        }

    private fun loadHiddenUnlocked(): Set<String> {
        if (!hiddenFile.exists()) return emptySet()
        return runCatching {
            json.decodeFromString<Set<String>>(hiddenFile.readText())
        }.getOrElse { emptySet() }
    }

    private fun loadUnlocked(): List<LocalRecentEntry> {
        if (!file.exists()) return emptyList()
        return runCatching {
            json.decodeFromString<List<LocalRecentEntry>>(file.readText())
        }.getOrElse { emptyList() }
    }
}
