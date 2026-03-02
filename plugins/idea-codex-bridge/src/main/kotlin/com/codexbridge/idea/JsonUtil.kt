package com.codexbridge.idea

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper

object JsonUtil {
    private val mapper = jacksonObjectMapper()

    fun stringify(any: Any): String = mapper.writeValueAsString(any)

    fun parseObject(json: String): Map<String, Any?>? {
        return try {
            mapper.readValue(json, object : TypeReference<Map<String, Any?>>() {})
        } catch (_: Exception) {
            null
        }
    }
}
