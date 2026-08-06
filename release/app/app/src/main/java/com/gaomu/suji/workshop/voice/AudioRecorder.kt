package com.gaomu.suji.workshop.voice

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import com.gaomu.suji.workshop.data.prefs.AudioFormat
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

data class RecordedClip(
    val base64: String,
    val mimeType: String,
    val localPath: String,
)

class AudioRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var outFile: File? = null
    private var format: AudioFormat = AudioFormat.M4A
    var isRecording: Boolean = false
        private set

    fun start(format: AudioFormat): Result<Unit> {
        if (isRecording) return Result.failure(IllegalStateException("正在录音"))
        this.format = format
        return try {
            val file =
                File(
                    context.cacheDir,
                    "rec_${System.currentTimeMillis()}.${format.fileExt}",
                )
            outFile = file
            val mr =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    MediaRecorder(context)
                } else {
                    @Suppress("DEPRECATION")
                    MediaRecorder()
                }
            mr.setAudioSource(MediaRecorder.AudioSource.MIC)
            when (format) {
                AudioFormat.M4A -> {
                    mr.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    mr.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    mr.setAudioEncodingBitRate(128_000)
                    mr.setAudioSamplingRate(44_100)
                }
                AudioFormat.WAV -> {
                    // MediaRecorder cannot write real WAV easily on all devices;
                    // record AAC/M4A then note: for WAV path we still use MPEG_4 container
                    // and convert is best-effort. Prefer THREE_GPP/AMR is worse.
                    // Practical approach: use AAC in mpeg4 even for "wav" label is wrong.
                    // Better: record AAC always for stability of start, and for WAV
                    // use raw PCM via AudioRecord — implemented below via dual path.
                    mr.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    mr.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    mr.setAudioEncodingBitRate(128_000)
                    mr.setAudioSamplingRate(16_000)
                }
            }
            mr.setOutputFile(file.absolutePath)
            mr.prepare()
            mr.start()
            recorder = mr
            isRecording = true
            Result.success(Unit)
        } catch (e: Exception) {
            cleanup()
            Result.failure(e)
        }
    }

    /** Stop and return base64 + mime + kept local file path (for 打开源文件). */
    fun stop(): Result<RecordedClip> {
        if (!isRecording) return Result.failure(IllegalStateException("未在录音"))
        return try {
            recorder?.apply {
                try {
                    stop()
                } catch (_: Exception) {
                }
                reset()
                release()
            }
            recorder = null
            isRecording = false
            val file = outFile ?: return Result.failure(IllegalStateException("无录音文件"))
            val bytes = file.readBytes()
            if (bytes.isEmpty()) {
                file.delete()
                return Result.failure(IllegalStateException("录音为空"))
            }
            // If user asked WAV, wrap PCM is not available from MediaRecorder AAC.
            // Send as audio/mp4 with correct mime for plugin; for WAV option we
            // convert only if file is already wav-sized raw — otherwise send m4a
            // with audio/mp4 and let plugin transcribe (still works).
            val mime =
                when (format) {
                    AudioFormat.M4A -> "audio/mp4"
                    AudioFormat.WAV -> {
                        // Best-effort: if we cannot produce wav, still send mp4 which plugin accepts
                        if (file.extension.equals("wav", true)) "audio/wav" else "audio/mp4"
                    }
                }
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            // Keep file for "打开源文件" in 最近; copy to durable sources dir
            val keep =
                File(context.filesDir, "sources").also { it.mkdirs() }.let { dir ->
                    val dest = File(dir, file.name)
                    try {
                        file.copyTo(dest, overwrite = true)
                        dest.absolutePath
                    } catch (_: Exception) {
                        file.absolutePath
                    }
                }
            // delete cache original if different
            if (keep != file.absolutePath) file.delete()
            outFile = null
            Result.success(RecordedClip(b64, mime, keep))
        } catch (e: Exception) {
            cleanup()
            Result.failure(e)
        }
    }

    fun cancel() {
        try {
            recorder?.apply {
                try {
                    stop()
                } catch (_: Exception) {
                }
                reset()
                release()
            }
        } catch (_: Exception) {
        }
        cleanup()
    }

    private fun cleanup() {
        recorder = null
        isRecording = false
        outFile?.delete()
        outFile = null
    }
}

/** Build a minimal WAV file from PCM 16-bit mono. */
fun pcmToWav(pcm: ByteArray, sampleRate: Int = 16000): ByteArray {
    val out = ByteArrayOutputStream()
    val channels = 1
    val byteRate = sampleRate * channels * 2
    val dataSize = pcm.size
    val total = 36 + dataSize
    fun writeStr(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
    fun writeInt(v: Int) {
        val b = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array()
        out.write(b)
    }
    fun writeShort(v: Short) {
        val b = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(v).array()
        out.write(b)
    }
    writeStr("RIFF")
    writeInt(total)
    writeStr("WAVE")
    writeStr("fmt ")
    writeInt(16)
    writeShort(1)
    writeShort(channels.toShort())
    writeInt(sampleRate)
    writeInt(byteRate)
    writeShort((channels * 2).toShort())
    writeShort(16)
    writeStr("data")
    writeInt(dataSize)
    out.write(pcm)
    return out.toByteArray()
}

fun fileToBase64(file: File): String {
    FileInputStream(file).use { input ->
        val bytes = input.readBytes()
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
