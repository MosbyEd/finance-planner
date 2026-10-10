"use client";

import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export type SaveResult = "shared" | "downloaded" | "cancelled";

function isCancel(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort|cancel/i.test(message);
}

/**
 * Сохраняет текстовый файл так, как удобно на этой платформе:
 * в iOS-приложении — через меню «Поделиться», на телефоне в браузере — через Web Share,
 * на компьютере — обычной загрузкой.
 */
export async function saveTextFile(filename: string, content: string, mime: string): Promise<SaveResult> {
  if (Capacitor.isNativePlatform()) {
    try {
      const written = await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title: filename, url: written.uri, dialogTitle: "Сохранить файл" });
      return "shared";
    } catch (error) {
      if (isCancel(error)) return "cancelled";
      throw error;
    }
  }

  const file = new File([content], filename, { type: mime });
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (coarse && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if (isCancel(error)) return "cancelled";
      // Если поделиться не вышло — пробуем обычную загрузку.
    }
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}
