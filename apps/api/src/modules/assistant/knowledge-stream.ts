// Extract only a top-level answer string from incomplete structured JSON. Never expose
// other fields, partial escapes or half a UTF-16 surrogate pair to the browser.
export function partialKnowledgeAnswer(json: string): string {
  let depth = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      const start = i;
      for (i++; i < json.length; i++) {
        if (json[i] === '\\') i++;
        else if (json[i] === '"') break;
      }
      if (i >= json.length) return '';
      if (depth !== 1 || JSON.parse(json.slice(start, i + 1)) !== 'answer') continue;
      const rest = json.slice(i + 1).match(/^\s*:\s*"/);
      if (!rest) continue;
      let result = '';
      for (let j = i + 1 + rest[0].length; j < json.length; j++) {
        const char = json[j]!;
        if (char === '"') break;
        if (char !== '\\') {
          result += char;
          continue;
        }
        const escape = json[++j];
        if (escape === undefined) break;
        if (escape === 'u') {
          const hex = json.slice(j + 1, j + 5);
          if (hex.length < 4) break;
          if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('Invalid unicode escape');
          result += String.fromCharCode(parseInt(hex, 16));
          j += 4;
        } else {
          result += JSON.parse('"\\' + escape + '"') as string;
        }
      }
      return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
    }
  }
  return '';
}

/** Only trust a completed boolean in the first top-level field. Other orders buffer.
 * Anchoring at the root prevents quoted/nested fake flags from opening the stream.
 */
export function leadingEvidenceDecision(json: string): boolean | undefined {
  const match = json.match(/^\s*\{\s*"evidenceSufficient"\s*:\s*(true|false)\s*[,}]/);
  return match ? match[1] === 'true' : undefined;
}
