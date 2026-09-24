"""Offline book import. Never execute HTML or fetch embedded resources."""
import codecs
import re
import posixpath
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote
from xml.etree import ElementTree as ET

MAX_SOURCE = 100 * 1024 * 1024
MAX_TEXT = 5_000_000


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        if tag in ('p', 'div', 'br', 'h1', 'h2', 'h3', 'li') and not self.hidden:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
        if tag in ('p', 'div', 'h1', 'h2', 'h3', 'li') and not self.hidden:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def clean_html(source):
    parser = PlainText()
    parser.feed(source)
    return re.sub(r'\n[ \t]*\n+', '\n\n', ''.join(parser.parts)).strip()


def import_book(path):
    path = Path(path)
    if path.stat().st_size > MAX_SOURCE:
        raise ValueError('输入文件超过 100 MB，请先拆分。')
    suffix = path.suffix.lower()
    chapters = []
    warnings = []
    title = path.stem
    if suffix == '.txt':
        raw = path.read_bytes()
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('gb18030')
        chapters = [{'title': title, 'text': text}]
    elif suffix == '.epub':
        with zipfile.ZipFile(path) as archive:
            if sum(i.file_size for i in archive.infolist()) > 300 * 1024 * 1024:
                raise ValueError('EPUB 解压体积超过限制。')
            container = ET.fromstring(archive.read('META-INF/container.xml'))
            opf = next(e.attrib['full-path'] for e in container.iter() if e.tag.endswith('rootfile'))
            root = ET.fromstring(archive.read(opf))
            title_node = next((e for e in root.iter() if e.tag.endswith('}title')), None)
            if title_node is not None and title_node.text:
                title = title_node.text
            items = {e.attrib['id']: e.attrib for e in root.iter() if e.tag.endswith('}item')}
            for entry in root.iter():
                if not entry.tag.endswith('}itemref') or entry.attrib.get('linear') == 'no':
                    continue
                item = items[entry.attrib['idref']]
                if item.get('media-type') not in ('application/xhtml+xml', 'text/html'):
                    continue
                name = posixpath.normpath(str(PurePosixPath(opf).parent / unquote(item['href'].split('#')[0])))
                if name.startswith('../') or name.startswith('/'):
                    raise ValueError('EPUB 正文路径越界。')
                # ZIP members are read directly, never extracted to the filesystem.
                html = archive.read(name).decode('utf-8-sig')
                text = clean_html(html)
                if text:
                    heading = re.search(r'<h[12]\b[^>]*>(.*?)</h[12]>', html, re.I | re.S)
                    chapters.append({'title': clean_html(heading[1]) if heading else f'第 {len(chapters)+1} 章', 'text': text})
    elif suffix == '.pdf':
        from pypdf import PdfReader
        pdf = PdfReader(path)
        if pdf.is_encrypted:
            raise ValueError('暂不支持加密 PDF，请先提供解密后的文件。')
        empty_pages = []
        for index, page in enumerate(pdf.pages):
            text = page.extract_text() or ''
            if text.strip():
                chapters.append({'title': f'第 {index+1} 页', 'text': text})
            else:
                empty_pages.append(index + 1)
        if not chapters:
            raise ValueError('PDF 中未提取到正文，扫描件需要 OCR，首版不支持。')
        if empty_pages:
            warnings.append('以下 PDF 页未提取到文字，请检查是否为扫描页或空白页：' + ', '.join(map(str, empty_pages)))
    else:
        raise ValueError('请选择 EPUB、TXT 或文本型 PDF。')
    validate_chapters(chapters)
    return {'title': title, 'chapters': chapters, 'warnings': warnings}


def validate_chapters(chapters):
    if not isinstance(chapters, list) or not chapters or len(chapters) > 10000:
        raise ValueError('需要 1–10000 个章节。')
    total = 0
    for chapter in chapters:
        if not isinstance(chapter.get('text'), str) or not chapter['text'].strip():
            raise ValueError('章节正文不能为空；请删除不需要的章节。')
        if not isinstance(chapter.get('title'), str):
            raise ValueError('章节标题无效。')
        total += len(chapter['text'])
    if total > MAX_TEXT:
        raise ValueError('正文超过 500 万字符，请拆分书籍。')


def split_text(text, language):
    """Exact contiguous source ranges; no punctuation, whitespace or tail dropped."""
    limit = 180 if language == 'Chinese' else 650
    start = 0
    while start < len(text):
        end = min(start + limit, len(text))
        newline = re.search(r'[\r\n]', text[start:end])
        if newline:
            end = start + newline.start()
            while end < len(text) and text[end] in '\r\n':
                end += 1
        elif end < len(text):
            cuts = [m.end() for m in re.finditer(r'[。！？.!?；;\n]+\s*', text[start:end])]
            if cuts:
                end = start + cuts[-1]
            else:
                space = text.rfind(' ', start, end)
                if space > start + limit // 2:
                    end = space + 1
        yield start, end, text[start:end]
        start = end
