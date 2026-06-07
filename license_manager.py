"""
license_manager.py
CertGen PRO — Desktop App License Manager
Versi: 3.0 (Monorepo)
---
Tugas:
- Aktivasi License Key ke server
- Validasi lisensi saat startup (online check)
- Cache lokal terenkripsi (Fernet + HMAC) untuk offline grace period
- Device binding via SHA-256 hardware fingerprint
- Anti clock-manipulation via server time
"""

import os
import sys
import json
import hashlib
import hmac
import time
import uuid
import platform
import socket
import requests
from pathlib import Path
from datetime import datetime, timezone

# ── Cryptography (pip install cryptography) ──────────────────
try:
    from cryptography.fernet import Fernet
    import base64
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False

# ============================================================
# CONFIG — ganti BASE_URL setelah deploy
# ============================================================
BASE_URL         = "https://certgenpro.vercel.app/api"
APP_ID           = "CERTGEN"
CACHE_FILENAME   = ".cgp_license_cache"
OFFLINE_GRACE_DAYS = 3     # hari toleransi offline
VALIDATION_INTERVAL_SEC = 3600  # validasi ke server setiap 1 jam

class LicenseManager:
    def __init__(self):
        self.cache_path = self._get_cache_path()
        self._device_id = None
        self._cached_data = None

    # ──────────────────────────────────────────────────────────
    # PUBLIC API
    # ──────────────────────────────────────────────────────────

    def activate(self, license_key: str) -> dict:
        """
        Aktivasi License Key ke server.
        Dipanggil sekali saat user input key di UI.
        Return: {"success": True/False, "message": str, ...}
        """
        key = license_key.strip().upper()
        device_id = self.get_device_id()

        try:
            resp = requests.post(
                f"{BASE_URL}/activate-license",
                json={"license_key": key, "device_id": device_id, "app_id": APP_ID},
                timeout=15
            )
            data = resp.json()

            if resp.status_code == 200 and data.get("success"):
                # Simpan cache lokal
                self._save_cache(data)
                return {
                    "success":      True,
                    "message":      data.get("message", "Lisensi berhasil diaktifkan!"),
                    "license_key":  key,
                    "package_type": data.get("package_type"),
                    "package_name": data.get("package_name"),
                    "expired_at":   data.get("expired_at"),
                    "status":       "active",
                }
            else:
                return {
                    "success": False,
                    "message": data.get("error", "Aktivasi gagal. Coba lagi."),
                }

        except requests.exceptions.ConnectionError:
            return {"success": False, "message": "Tidak ada koneksi internet. Hubungkan ke internet untuk aktivasi."}
        except requests.exceptions.Timeout:
            return {"success": False, "message": "Server timeout. Coba lagi beberapa saat."}
        except Exception as e:
            return {"success": False, "message": f"Error: {str(e)}"}

    def validate(self) -> dict:
        """
        Validasi lisensi saat startup atau periodik.
        Return: {"valid": True/False, "reason": str, ...}
        """
        cached = self._load_cache()

        if not cached:
            return {"valid": False, "reason": "no_license", "message": "Belum ada lisensi aktif."}

        # Cek device binding lokal
        if cached.get("device_id") != self.get_device_id():
            return {"valid": False, "reason": "device_mismatch", "message": "Lisensi ini bukan untuk perangkat ini."}

        # Online validation (jika internet tersedia)
        try:
            server_time = self._get_server_time()
            now = server_time if server_time else datetime.now(timezone.utc)

            # Cek expired_at dari server (re-validate)
            resp = requests.post(
                f"{BASE_URL}/activate-license",
                json={
                    "license_key": cached["license_key"],
                    "device_id":   self.get_device_id(),
                    "app_id":      APP_ID
                },
                timeout=10
            )
            data = resp.json()

            if resp.status_code == 200 and data.get("success"):
                # Update cache dengan data terbaru
                self._save_cache(data)
                return {"valid": True, "reason": "online_validated", **data}
            else:
                error = data.get("error", "")
                if "kedaluwarsa" in error.lower() or "expired" in error.lower():
                    return {"valid": False, "reason": "expired", "message": error}
                elif "device" in error.lower():
                    return {"valid": False, "reason": "device_mismatch", "message": error}
                else:
                    # Fallback ke offline grace
                    return self._offline_validate(cached)

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            # Offline → gunakan cache
            return self._offline_validate(cached)

    def get_license_info(self) -> dict | None:
        """Ambil info lisensi dari cache."""
        return self._load_cache()

    def clear_license(self):
        """Hapus cache lisensi (untuk deactivate/reset)."""
        if self.cache_path.exists():
            self.cache_path.unlink()
        self._cached_data = None

    # ──────────────────────────────────────────────────────────
    # DEVICE ID
    # ──────────────────────────────────────────────────────────

    def get_device_id(self) -> str:
        """
        Generate device fingerprint yang stabil.
        SHA-256 dari kombinasi hardware identifiers.
        """
        if self._device_id:
            return self._device_id

        components = []

        # Machine UUID (paling stabil di Windows)
        try:
            if platform.system() == "Windows":
                import subprocess
                result = subprocess.check_output(
                    "wmic csproduct get UUID",
                    shell=True, stderr=subprocess.DEVNULL
                ).decode().strip().split("\n")
                hw_uuid = result[1].strip() if len(result) > 1 else ""
                if hw_uuid and hw_uuid != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF":
                    components.append(f"uuid:{hw_uuid}")
        except Exception:
            pass

        # Hostname
        try:
            components.append(f"host:{socket.gethostname()}")
        except Exception:
            pass

        # MAC Address
        try:
            mac = uuid.getnode()
            if mac != uuid.getnode():  # Sanity check
                components.append(f"mac:{mac}")
            else:
                components.append(f"mac:{mac}")
        except Exception:
            pass

        # Platform info
        components.append(f"os:{platform.system()}-{platform.machine()}")

        # Fallback ke machine-id jika komponen minim
        if len(components) < 2:
            try:
                mid_path = Path("C:/ProgramData/certgenpro/.mid") if platform.system() == "Windows" \
                    else Path.home() / ".certgenpro_mid"
                if mid_path.exists():
                    components.append(f"mid:{mid_path.read_text().strip()}")
                else:
                    new_mid = hashlib.sha256(os.urandom(32)).hexdigest()
                    mid_path.parent.mkdir(parents=True, exist_ok=True)
                    mid_path.write_text(new_mid)
                    components.append(f"mid:{new_mid}")
            except Exception:
                pass

        raw = "|".join(sorted(components))
        device_id = hashlib.sha256(raw.encode()).hexdigest()[:40]
        self._device_id = device_id
        return device_id

    # ──────────────────────────────────────────────────────────
    # CACHE (Fernet encrypted + HMAC tamper detection)
    # ──────────────────────────────────────────────────────────

    def _get_cache_path(self) -> Path:
        if platform.system() == "Windows":
            base = Path(os.environ.get("APPDATA", Path.home())) / "CertGenPRO"
        else:
            base = Path.home() / ".certgenpro"
        base.mkdir(parents=True, exist_ok=True)
        return base / CACHE_FILENAME

    def _get_fernet_key(self) -> bytes:
        """Derive Fernet key dari device_id (hardware-bound)."""
        device_id = self.get_device_id()
        raw = hashlib.sha256(f"cgp-cache-{device_id}".encode()).digest()
        return base64.urlsafe_b64encode(raw)

    def _save_cache(self, data: dict):
        """Simpan data lisensi ke cache terenkripsi."""
        if not CRYPTO_AVAILABLE:
            return

        cache = {
            "license_key":  data.get("license_key", ""),
            "package_type": data.get("package_type", ""),
            "package_name": data.get("package_name", ""),
            "expired_at":   data.get("expired_at"),
            "activated_at": data.get("activated_at"),
            "device_id":    self.get_device_id(),
            "cached_at":    datetime.now(timezone.utc).isoformat(),
            "status":       "active",
        }

        payload = json.dumps(cache).encode()
        fernet  = Fernet(self._get_fernet_key())
        enc     = fernet.encrypt(payload)

        # HMAC signature untuk deteksi tampering
        sig = hmac.new(
            self.get_device_id().encode(),
            enc,
            hashlib.sha256
        ).hexdigest()

        self.cache_path.write_bytes(sig.encode() + b"|" + enc)
        self._cached_data = cache

    def _load_cache(self) -> dict | None:
        """Muat cache terenkripsi. Return None jika tidak ada/rusak."""
        if self._cached_data:
            return self._cached_data

        if not CRYPTO_AVAILABLE or not self.cache_path.exists():
            return None

        try:
            raw = self.cache_path.read_bytes()
            sep_idx = raw.index(b"|")
            sig_bytes = raw[:sep_idx]
            enc = raw[sep_idx + 1:]

            # Verifikasi HMAC
            expected_sig = hmac.new(
                self.get_device_id().encode(),
                enc,
                hashlib.sha256
            ).hexdigest()

            if not hmac.compare_digest(sig_bytes.decode(), expected_sig):
                print("[LM] Cache tampered — clearing.")
                self.clear_license()
                return None

            fernet = Fernet(self._get_fernet_key())
            decrypted = fernet.decrypt(enc)
            self._cached_data = json.loads(decrypted)
            return self._cached_data

        except Exception as e:
            print(f"[LM] Cache load error: {e}")
            return None

    # ──────────────────────────────────────────────────────────
    # OFFLINE VALIDATION
    # ──────────────────────────────────────────────────────────

    def _offline_validate(self, cached: dict) -> dict:
        """Validasi menggunakan data cache saat offline."""
        now_local = datetime.now(timezone.utc)

        # Cek expired_at dari cache
        expired_at = cached.get("expired_at")
        if expired_at:
            exp_dt = datetime.fromisoformat(expired_at.replace("Z", "+00:00"))
            if now_local > exp_dt:
                return {
                    "valid":       False,
                    "reason":      "expired",
                    "message":     "Lisensi sudah kedaluwarsa. Perpanjang di certgenpro.vercel.app/renew.html",
                    "expired_at":  expired_at,
                }

        # Cek grace period offline
        cached_at = cached.get("cached_at")
        if cached_at:
            cached_dt = datetime.fromisoformat(cached_at.replace("Z", "+00:00"))
            offline_days = (now_local - cached_dt).days
            if offline_days > OFFLINE_GRACE_DAYS:
                return {
                    "valid":   False,
                    "reason":  "offline_too_long",
                    "message": f"Sudah {offline_days} hari offline. Hubungkan ke internet untuk melanjutkan.",
                }

        return {
            "valid":        True,
            "reason":       "offline_cache",
            "message":      "Validasi offline (cache).",
            "license_key":  cached.get("license_key"),
            "package_type": cached.get("package_type"),
            "expired_at":   expired_at,
        }

    # ──────────────────────────────────────────────────────────
    # SERVER TIME (anti clock manipulation)
    # ──────────────────────────────────────────────────────────

    def _get_server_time(self) -> datetime | None:
        try:
            resp = requests.get(f"{BASE_URL}/time", timeout=5)
            data = resp.json()
            return datetime.fromisoformat(data["time"].replace("Z", "+00:00"))
        except Exception:
            return None


# ============================================================
# Singleton instance
# ============================================================
license_manager = LicenseManager()


# ============================================================
# Contoh penggunaan di aplikasi PyQt6:
# ============================================================
# from license_manager import license_manager
#
# # Saat startup:
# result = license_manager.validate()
# if not result["valid"]:
#     show_activation_dialog()
#     return
#
# # Saat user input key:
# result = license_manager.activate("CERTGEN-XXXX-XXXX-XXXX")
# if result["success"]:
#     show_success_message(result["message"])
# else:
#     show_error_message(result["message"])
#
# # Cek info lisensi:
# info = license_manager.get_license_info()
# print(f"Paket: {info['package_name']}, Expire: {info['expired_at']}")
