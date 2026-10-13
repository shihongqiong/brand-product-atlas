"""Validate a researched catalog and prepare official images and traceable deliverables."""
import argparse, concurrent.futures, csv, hashlib, io, json, re, urllib.parse, urllib.request, zipfile
from pathlib import Path
from PIL import Image

def validate_schema(value, schema, location='catalog'):
    # This catalog schema uses this bounded subset of JSON Schema; no runtime installation.
    typechecks={'object':lambda v:isinstance(v,dict), 'array':lambda v:isinstance(v,list),
                'string':lambda v:isinstance(v,str), 'integer':lambda v:isinstance(v,int) and not isinstance(v,bool),
                'boolean':lambda v:isinstance(v,bool), 'null':lambda v:v is None}
    kinds=schema.get('type',[]); kinds=[kinds] if isinstance(kinds,str) else kinds
    if kinds and not any(typechecks[k](value) for k in kinds): raise ValueError(location+' 数据类型无效')
    if 'enum' in schema and value not in schema['enum']: raise ValueError(location+' 取值无效')
    if isinstance(value,dict):
        for key in schema.get('required',[]):
            if key not in value: raise ValueError(location+' 缺少 '+key)
        for key, rule in schema.get('properties',{}).items():
            if key in value: validate_schema(value[key],rule,location+'.'+key)
    if isinstance(value,list):
        if len(value)<schema.get('minItems',0) or len(value)>schema.get('maxItems',float('inf')): raise ValueError(location+' 数量不符')
        if 'items' in schema:
            for index, item in enumerate(value): validate_schema(item,schema['items'],location+f'[{index}]')
    if isinstance(value,str):
        if schema.get('pattern') and not re.fullmatch(schema['pattern'],value): raise ValueError(location+' 格式无效')
        if len(value)<schema.get('minLength',0): raise ValueError(location+' 不能为空')
        if schema.get('format')=='uri':
            url=urllib.parse.urlsplit(value)
            if url.scheme not in ('http','https') or not url.netloc: raise ValueError(location+' 网址无效')
    if isinstance(value,int) and not isinstance(value,bool) and value<schema.get('minimum',value): raise ValueError(location+' 数值小于下限')
    if isinstance(value,int) and not isinstance(value,bool) and value>schema.get('maximum',value): raise ValueError(location+' 数值超过上限')

def safe_name(value):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', value).strip('. ')[:72] or 'product'

def atomic_json(file, data):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(file)

def validate(data):
    schema = json.loads((Path(__file__).resolve().parent.parent / 'references/catalog.schema.json').read_text())
    validate_schema(data,schema)
    nodes = {n['id']: n for n in data['nodes']}
    if len(nodes) != len(data['nodes']):
        raise ValueError('分类 id 重复')
    if not any(n['parent_id'] is None for n in nodes.values()):
        raise ValueError('缺少产品线根节点')
    requested = data.get('samples_per_category', 6)
    for node in nodes.values():
        seen, current = set(), node
        while current['parent_id'] is not None:
            if current['id'] in seen:
                raise ValueError('分类层级存在循环')
            seen.add(current['id'])
            if current['parent_id'] not in nodes:
                raise ValueError('父分类不存在：' + current['parent_id'])
            current = nodes[current['parent_id']]
        products = node.get('selected_products', [])
        if len(products)>requested: raise ValueError('选取产品数量超过用户设置：'+node['name'])
        keys = [p['product_url'] for p in products]
        if len(keys) != len(set(keys)):
            raise ValueError('同一小类选择了重复产品：' + node['name'])
        if node.get('listed_count') is not None and node['listed_count'] < len(products):
            raise ValueError('官网条目数量少于已选产品：' + node['name'])
        if node.get('inventory_complete') and len(node.get('inventory', [])) != node.get('listed_count'):
            raise ValueError('完整清单与官网数量不符：' + node['name'])
    return nodes

def trail(node, nodes):
    parts = [node['name']]
    while node['parent_id'] is not None:
        node = nodes[node['parent_id']]
        parts.insert(0, node['name'])
    return ' / '.join(parts)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('catalog'); ap.add_argument('--output', required=True)
    ap.add_argument('--allow-local-assets', action='store_true', help='Only for verified local reference images')
    args = ap.parse_args()
    root = Path(args.output).resolve(); root.mkdir(parents=True, exist_ok=True)
    data = json.loads(Path(args.catalog).read_text(encoding='utf-8'))
    # Theme shares the same official-source contract as the catalog.
    if not data.get('visual_identity'):
        workbench=Path(__file__).resolve().parents[2]
        hostname=urllib.parse.urlsplit(data['official_url']).hostname or ''
        try:
            themes=json.loads((workbench/'brand-themes.json').read_text())
            for domain,theme in themes.items():
                if hostname==domain or hostname.endswith('.'+domain):data['visual_identity']=theme;break
        except (OSError,ValueError):pass
        if not data.get('visual_identity'):
            cache=workbench/'.official-lookups'
            for file in sorted(cache.glob('*/result.json'),reverse=True):
                try:
                    found=json.loads(file.read_text());site=urllib.parse.urlsplit(found.get('official_url','')).hostname
                    if found.get('brand','').casefold()==data['brand'].casefold() and site==hostname and re.fullmatch(r'#[0-9A-Fa-f]{6}',found.get('accent_color','')):
                        data['visual_identity']={'accent_color':found['accent_color'],'basis':'inferred','source_url':found['theme_source_url'],'note':'依据已核验官网视觉风格归纳'};break
                except (OSError,ValueError,KeyError):pass
    nodes = validate(data)
    assets = root / 'assets'; assets.mkdir(exist_ok=True)
    tasks = [(n, p) for n in data['nodes'] for p in n.get('selected_products', [])]
    image_hashes = {}

    def fetch(item):
        node, product = item
        product.pop('image_error', None)
        product.pop('asset_path', None)
        url = product.get('image_url')
        try:
            if args.allow_local_assets and product.get('local_reference'):
                raw = Path(product['local_reference']).read_bytes()
            else:
                if not url: raise ValueError('官网暂无可核验图片')
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme not in ('http', 'https') or not parsed.netloc:
                    raise ValueError('图片网址无效')
                if not product.get('image_evidence_url'):
                    raise ValueError('缺少图片引用的官网证据页')
                # UI's image proxy exposes the original official CDN URL in its u parameter.
                original_url = urllib.parse.parse_qs(parsed.query).get('u', [url])[0] if parsed.hostname == 'images.svc.ui.com' else url
                original_parts = urllib.parse.urlsplit(original_url)
                if original_parts.scheme not in ('http','https'): original_url=url
                product['download_url']=original_url
                request = urllib.request.Request(original_url, headers={'User-Agent':'Mozilla/5.0', 'Referer':product['image_evidence_url']})
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read(18 * 1024 * 1024 + 1)
                if len(raw) > 18 * 1024 * 1024: raise ValueError('图片大于18MB')
            with Image.open(io.BytesIO(raw)) as source:
                source.load()
                if min(source.size) < 80: raise ValueError('图像分辨率过小，需核验是否为图标')
                image = source.convert('RGBA')
                image.thumbnail((1600, 1600))
                folder = assets / safe_name(trail(node, nodes).replace(' / ', '__'))
                folder.mkdir(exist_ok=True)
                key = hashlib.sha256((node['id'] + product['product_url']).encode()).hexdigest()[:10]
                file = folder / (safe_name(product.get('model') or product['name']) + '_' + key + '.png')
                image.save(file)
                product['asset_path'] = str(file.relative_to(root))
                product['image_sha256'] = hashlib.sha256(raw).hexdigest()
                return True
        except Exception as error:
            product['image_error'] = str(error)[:240]
            return False

    complete = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for index, ok in enumerate(pool.map(fetch, tasks), 1):
            complete += int(ok)
            atomic_json(root / 'progress.json', {'stage':'images', 'message':f'已读取 {index}/{len(tasks)} 个产品图片，成功 {complete} 个'})
    data['research_notes'] = list(data['coverage']['notes'])
    data['coverage']['notes'] = [note for note in data['coverage']['notes'] if not re.search('未下载|未进行视觉预览',note)]
    gaps = list(data['coverage']['notes'])
    requested = data.get('samples_per_category',6)
    children = {n['parent_id'] for n in nodes.values() if n['parent_id'] is not None}
    for node in nodes.values():
        selected = node.get('selected_products', [])
        if node['id'] not in children and not node.get('inventory_complete'):
            if data['coverage']['status'] == 'complete': data['coverage']['status'] = 'partial'
        digests = [p.get('image_sha256') for p in selected if p.get('image_sha256')]
        if len(digests) != len(set(digests)):
            node['image_warning'] = '不同产品引用相同图片，请人工核对是否为共用系列图'
            gaps.append(trail(node, nodes) + '：' + node['image_warning'])
        if node.get('gap'): gaps.append(trail(node, nodes) + '：' + node['gap'])
        if node['id'] not in children and len(selected) < requested:
            gaps.append(trail(node, nodes) + f'：已选 {len(selected)} 个产品，目标为 {requested} 个')
        for p in selected:
            if p.get('image_error'): gaps.append(trail(node, nodes) + ' / ' + p['name'] + '：' + p['image_error'])
    data['delivery_gaps'] = list(dict.fromkeys(gaps))
    for _,product in tasks: product.pop('local_reference',None)
    data['stats'] = {'nodes':len(nodes), 'leaf_categories':sum(n['id'] not in children for n in nodes.values()), 'selected_products':len(tasks), 'images':complete}
    atomic_json(root / 'catalog.enriched.json', data)
    with (root / '图片来源.csv').open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.writer(file); writer.writerow(['分类路径','产品名称','型号','官网分类页','产品页','图片网址','下载地址','图片引用页','图片类型','本地图片','采集状态'])
        for n,p in tasks:
            writer.writerow([trail(n,nodes),p['name'],p.get('model',''),n['source_url'],p['product_url'],p.get('image_url',''),p.get('download_url',p.get('image_url','')),p.get('image_evidence_url',''),p['image_kind'],p.get('asset_path',''),p.get('image_error','已下载')])
    with (root / '产品清单.csv').open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.writer(file); writer.writerow(['分类路径','产品名称','官网链接','清单完整性'])
        for n in nodes.values():
            for p in n.get('inventory', []):
                writer.writerow([trail(n,nodes),p['name'],p['product_url'],'已核验完整' if n.get('inventory_complete') else '部分'])
    with zipfile.ZipFile(root / '官方产品图片与来源.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for relative in dict.fromkeys(p['asset_path'] for _,p in tasks if p.get('asset_path')):
            file=root/relative; archive.write(file,relative)
        for name in ['图片来源.csv','产品清单.csv','catalog.enriched.json']: archive.write(root / name, name)
    print(json.dumps(data['stats'], ensure_ascii=False))

if __name__ == '__main__': main()
