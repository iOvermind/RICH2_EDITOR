// src/utils/compression.ts

/**
 * 真實的一般資料解壓法 (加上嚴格邊界保護)
 */
export function decompressGeneralData(dataView: DataView, startOffset: number): Uint8Array {
    // 防呆：如果起始位置就已經超過檔案大小，直接回傳空陣列
    if (startOffset < 0 || startOffset + 2 > dataView.byteLength) {
        console.error(`[解壓錯誤] 嘗試從無效的偏移量讀取: ${startOffset}`);
        return new Uint8Array(0);
    }

    const output: number[] = [];
    const no = dataView.getUint16(startOffset, true);
    let currentPtr = startOffset + 2;

    for (let i = 0; i < no; i++) {
        if (currentPtr >= dataView.byteLength) break;

        const b = dataView.getUint8(currentPtr++);
        const c = (b & 0x7F) + 1;
        const isHighBitSet = (b & 0x80) !== 0;

        if (isHighBitSet) {
            for (let j = 0; j < c; j++) {
                if (currentPtr >= dataView.byteLength) break; // 雙重防呆
                output.push(dataView.getUint8(currentPtr++));
            }
        } else {
            if (currentPtr >= dataView.byteLength) break;   // 雙重防呆
            const repeatByte = dataView.getUint8(currentPtr++);
            for (let j = 0; j < c; j++) {
                output.push(repeatByte);
            }
        }
    }
    return new Uint8Array(output);
}

/**
 * 實作真正的 RLE 壓縮，並加入偶數對齊防崩潰機制
 */
export function compressGeneralData(inputBytes: Uint8Array): Uint8Array {
    const output: number[] = [];
    let i = 0;
    let chunks = 0;

    while (i < inputBytes.length) {
        let repeatCount = 1;
        while (i + repeatCount < inputBytes.length && repeatCount < 128 && inputBytes[i + repeatCount] === inputBytes[i]) {
            repeatCount++;
        }

        if (repeatCount >= 3) {
            output.push(repeatCount - 1);
            output.push(inputBytes[i]);
            i += repeatCount;
            chunks++;
        } else {
            let rawCount = 0;
            while (i + rawCount < inputBytes.length && rawCount < 128) {
                if (i + rawCount + 2 < inputBytes.length &&
                    inputBytes[i + rawCount] === inputBytes[i + rawCount + 1] &&
                    inputBytes[i + rawCount] === inputBytes[i + rawCount + 2]) {
                    break;
                }
                rawCount++;
            }

            output.push(0x80 | (rawCount - 1));
            for (let j = 0; j < rawCount; j++) {
                output.push(inputBytes[i + j]);
            }
            i += rawCount;
            chunks++;
        }
    }

    const isOdd = (output.length % 2 !== 0);
    const result = new Uint8Array(2 + output.length + (isOdd ? 1 : 0));
    result[0] = chunks & 0xFF;
    result[1] = (chunks >> 8) & 0xFF;
    result.set(output, 2);
    return result;
}