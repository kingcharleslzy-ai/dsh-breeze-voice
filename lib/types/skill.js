import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function bundledVoiceSkill() {
    const path = fileURLToPath(new URL('../skills/breeze-voice/SKILL.md', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
    if (!match)
        throw Error('语音技能缺少 frontmatter');
    const meta = Object.fromEntries(match[1].split(/\r?\n/).map(line => { const field = line.match(/^(name|description|whenToUse): (.+)$/); if (!field)
        throw Error('语音技能元数据无效'); return [field[1], field[2]]; }));
    if (meta.name !== 'breeze-voice' || !meta.description || !meta.whenToUse || !match[2].trim())
        throw Error('语音技能内容不完整');
    return { name: meta.name, description: meta.description, whenToUse: meta.whenToUse, content: match[2].trim(), path, source: '语音', invocation: { modelInvocable: true, userInvocable: true } };
}
