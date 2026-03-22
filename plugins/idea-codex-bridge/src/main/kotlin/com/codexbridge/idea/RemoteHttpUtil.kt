package com.codexbridge.idea

import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.text.Charsets.UTF_8

data class HttpTextResponse(
    val statusCode: Int,
    val body: String,
    val contentType: String
)

object RemoteHttpUtil {
    private const val CONNECT_TIMEOUT_MS = 4_000
    private const val READ_TIMEOUT_MS = 12_000

    fun openConnection(
        rawUrl: String,
        method: String,
        headers: Map<String, String> = emptyMap()
    ): HttpURLConnection {
        val connection = URL(rawUrl).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        connection.doInput = true
        if (method == "POST" || method == "PUT" || method == "PATCH") {
            connection.doOutput = true
        }
        headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
        return connection
    }

    fun get(rawUrl: String, headers: Map<String, String> = emptyMap()): HttpTextResponse {
        val connection = openConnection(rawUrl, "GET", headers)
        return readResponse(connection)
    }

    fun post(
        rawUrl: String,
        body: String? = null,
        headers: Map<String, String> = emptyMap()
    ): HttpTextResponse {
        val connection = openConnection(rawUrl, "POST", headers)
        if (body != null) {
            connection.outputStream.use { output ->
                output.write(body.toByteArray(UTF_8))
                output.flush()
            }
        }
        return readResponse(connection)
    }

    fun readResponse(connection: HttpURLConnection): HttpTextResponse {
        val status = connection.responseCode
        val contentType = connection.contentType.orEmpty()
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val body = stream.readUtf8()
        connection.disconnect()
        return HttpTextResponse(status, body, contentType)
    }

    private fun InputStream?.readUtf8(): String {
        if (this == null) return ""
        return use { input ->
            BufferedReader(InputStreamReader(input, UTF_8)).readText()
        }
    }
}
