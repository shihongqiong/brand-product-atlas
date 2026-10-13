"""Export checked slide renders to a matching PDF and verify page count/geometry."""
import argparse,json
from pathlib import Path
from PIL import Image
from pypdf import PdfReader

def export(root,pages):
    root=Path(root).resolve();target=root/'output/产品图谱.pdf';target.parent.mkdir(exist_ok=True)
    images=[]
    for i in range(1,pages+1):
        with Image.open(root/'renders'/f'slide-{i:03}.png') as source:
            rgba=source.convert('RGBA');white=Image.new('RGBA',rgba.size,'white');white.alpha_composite(rgba);images.append(white.convert('RGB'))
    if not images:raise ValueError('没有可导出的页面')
    temp=target.with_suffix('.tmp.pdf')
    images[0].save(temp,'PDF',save_all=True,append_images=images[1:],resolution=96,title='品牌产品线图谱',author='品牌产品图谱工作台')
    reader=PdfReader(temp)
    if len(reader.pages)!=pages:raise ValueError('PDF页数不符')
    for page in reader.pages:
        if abs(float(page.mediabox.width)/float(page.mediabox.height)-16/9)>.005:raise ValueError('PDF页面比例异常')
    temp.replace(target)
    for image in images:image.close()
    return {'file':'output/产品图谱.pdf','pages':pages,'bytes':target.stat().st_size,'render_based':True}

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('root');ap.add_argument('--pages',type=int,required=True);a=ap.parse_args();print(json.dumps(export(a.root,a.pages),ensure_ascii=False))
