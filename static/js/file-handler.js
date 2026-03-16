/**
 * static/js/file-handler.js
 * Модуль обробки файлів.
 *
 * Функції:
 *   - Зчитування файлу з input (FileReader API → ArrayBuffer)
 *   - Прогрес зчитування
 *   - Збирання chunk-ів отриманого файлу
 *   - Збереження розшифрованого файлу (download)
 */

const FileHandler = (() => {
    'use strict';

    // ── Зчитування файлу ───────────────────────────────────────────

    /**
     * Зчитує файл з <input type="file"> як ArrayBuffer.
     *
     * @param {File} file — об'єкт File з input
     * @param {Function} onProgress — колбек прогресу (0..1)
     * @returns {Promise<ArrayBuffer>}
     */
    function readFile(file, onProgress) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                resolve(e.target.result);
            };

            reader.onerror = (e) => {
                reject(new Error(`Помилка зчитування файлу: ${e.target.error?.message || 'unknown'}`));
            };

            reader.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(e.loaded / e.total);
                }
            };

            reader.readAsArrayBuffer(file);
        });
    }

    // ── Збереження файлу (download) ────────────────────────────────

    /**
     * Ініціює завантаження файлу у браузері.
     *
     * @param {ArrayBuffer|Uint8Array} data — дані файлу
     * @param {string} filename — ім'я файлу
     * @param {string} contentType — MIME-тип
     */
    function downloadFile(data, filename, contentType) {
        contentType = contentType || 'application/octet-stream';

        const blob = new Blob([data], { type: contentType });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'download';
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();

        // Очищення
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // ── Збирач chunk-ів ────────────────────────────────────────────

    /**
     * Створює збирач для отримання файлу по chunk-ах.
     *
     * @param {number} totalChunks — очікувана кількість chunk-ів
     * @param {Function} onProgress — колбек прогресу
     * @returns {Object} — збирач з методами addChunk() та getResult()
     */
    function createChunkCollector(totalChunks, onProgress) {
        const chunks = new Array(totalChunks).fill(null);
        let received = 0;

        return {
            /**
             * Додає chunk за індексом.
             * @param {number} index
             * @param {ArrayBuffer|Uint8Array} data
             * @returns {boolean} true якщо всі chunk-и зібрані
             */
            addChunk(index, data) {
                if (index < 0 || index >= totalChunks) {
                    console.error(`[FileHandler] Invalid chunk index: ${index}/${totalChunks}`);
                    return false;
                }

                if (chunks[index] === null) {
                    received++;
                }
                chunks[index] = data;

                if (onProgress) {
                    onProgress(received / totalChunks, received, totalChunks);
                }

                return received === totalChunks;
            },

            /**
             * Повертає зібраний файл як Uint8Array.
             * @returns {Uint8Array|null}
             */
            getResult() {
                if (received !== totalChunks) return null;

                // Обчислюємо загальний розмір
                let totalSize = 0;
                for (const chunk of chunks) {
                    totalSize += chunk.byteLength || chunk.length;
                }

                // Збираємо
                const result = new Uint8Array(totalSize);
                let offset = 0;
                for (const chunk of chunks) {
                    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    result.set(u8, offset);
                    offset += u8.length;
                }

                return result;
            },

            /** Кількість отриманих chunk-ів */
            get receivedCount() { return received; },

            /** Чи зібрано всі */
            get isComplete() { return received === totalChunks; },
        };
    }

    // ── Форматування розміру файлу ─────────────────────────────────

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Б';
        const units = ['Б', 'КБ', 'МБ', 'ГБ'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    // ── Валідація файлу ────────────────────────────────────────────

    function validateFile(file, maxSizeBytes) {
        maxSizeBytes = maxSizeBytes || 104857600; // 100 МБ

        if (!file) {
            return { valid: false, error: 'Файл не обрано' };
        }

        if (file.size === 0) {
            return { valid: false, error: 'Файл порожній' };
        }

        if (file.size > maxSizeBytes) {
            return {
                valid: false,
                error: `Файл занадто великий (${formatFileSize(file.size)}). Максимум: ${formatFileSize(maxSizeBytes)}`
            };
        }

        return { valid: true, error: null };
    }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        readFile,
        downloadFile,
        createChunkCollector,
        formatFileSize,
        validateFile,
    };
})();
