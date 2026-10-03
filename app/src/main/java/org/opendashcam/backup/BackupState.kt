package org.opendashcam.backup

import org.json.JSONObject
import org.opendashcam.storage.ClipStorage
import java.io.File

/** Per-clip backup record, stored in the "<clip>.backup" sidecar so it moves with the clip. */
object BackupState {
    fun isBackedUp(video: File, targetId: String): Boolean = try {
        val f = ClipStorage.sidecar(video, "backup")
        f.exists() && JSONObject(f.readText()).optJSONObject("smb")?.optString("target") == targetId
    } catch (e: Exception) {
        false
    }

    fun isOnServer(video: File, serverKey: String): Boolean = try {
        val f = ClipStorage.sidecar(video, "backup")
        f.exists() && JSONObject(f.readText()).optJSONObject("server")?.optString("key") == serverKey
    } catch (e: Exception) {
        false
    }

    fun markServer(video: File, serverKey: String, clipId: String, sha256: String) {
        val f = ClipStorage.sidecar(video, "backup")
        val root = try { if (f.exists()) JSONObject(f.readText()) else JSONObject() } catch (e: Exception) { JSONObject() }
        root.put("server", JSONObject().put("key", serverKey).put("clipId", clipId).put("sha256", sha256).put("at", System.currentTimeMillis()))
        f.writeText(root.toString())
    }

        fun markSmb(video: File, targetId: String, remotePath: String, sha256: String, size: Long, encrypted: Boolean) {
        val f = ClipStorage.sidecar(video, "backup")
        val root = try { if (f.exists()) JSONObject(f.readText()) else JSONObject() } catch (e: Exception) { JSONObject() }
        root.put(
            "smb",
            JSONObject()
                .put("target", targetId)
                .put("remote", remotePath)
                .put("sha256", sha256)
                .put("size", size)
                .put("encrypted", encrypted)
                .put("at", System.currentTimeMillis()),
        )
        f.writeText(root.toString())
    }
}
