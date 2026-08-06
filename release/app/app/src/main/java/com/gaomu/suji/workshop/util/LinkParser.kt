package com.gaomu.suji.workshop.util

data class BridgeLink(
    val baseUrl: String,
    val token: String,
    val raw: String,
)

object LinkParser {
    /**
     * Accepts full bridge URLs like:
     * http://100.81.234.60:27124/?t=abc
     * http://[fd7a:...]:27124/?t=abc
     * https://xxx.trycloudflare.com/?t=abc
     */
    fun parse(input: String): Result<BridgeLink> {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) {
            return Result.failure(IllegalArgumentException("请粘贴电脑生成的完整链接"))
        }
        return try {
            val withScheme =
                if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                    trimmed
                } else {
                    "http://$trimmed"
                }
            val uri = android.net.Uri.parse(withScheme)
            val host = uri.host?.trim().orEmpty()
            if (host.isEmpty()) {
                return Result.failure(IllegalArgumentException("链接缺少主机地址"))
            }
            val port = when {
                uri.port != -1 -> uri.port
                uri.scheme.equals("https", true) -> 443
                else -> 80
            }
            val token =
                uri.getQueryParameter("t")?.trim().orEmpty().ifEmpty {
                    // also accept bare token pasted alone? no — require full link for A
                    ""
                }
            if (token.isEmpty()) {
                return Result.failure(IllegalArgumentException("链接缺少令牌 ?t= ，请复制完整手机链接"))
            }
            val scheme = uri.scheme ?: "http"
            val authority =
                if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) {
                    host.bracketIfIpv6()
                } else {
                    "${host.bracketIfIpv6()}:$port"
                }
            val baseUrl = "$scheme://$authority".trimEnd('/')
            Result.success(BridgeLink(baseUrl = baseUrl, token = token, raw = withScheme))
        } catch (e: Exception) {
            Result.failure(IllegalArgumentException("无法解析链接：${e.message ?: e}"))
        }
    }

    fun buildFromParts(host: String, port: Int, token: String, https: Boolean = false): Result<BridgeLink> {
        val h = host.trim()
        val t = token.trim()
        if (h.isEmpty()) return Result.failure(IllegalArgumentException("主机不能为空"))
        if (t.isEmpty()) return Result.failure(IllegalArgumentException("令牌不能为空"))
        if (port !in 1..65535) return Result.failure(IllegalArgumentException("端口无效"))
        val scheme = if (https) "https" else "http"
        val baseUrl = "$scheme://${h.bracketIfIpv6()}:$port"
        return Result.success(BridgeLink(baseUrl, t, "$baseUrl/?t=$t"))
    }

    private fun String.bracketIfIpv6(): String {
        return if (contains(":") && !startsWith("[")) "[$this]" else this
    }
}
