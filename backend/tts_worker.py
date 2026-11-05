"""Launch pinned upstream Breeze in a disposable, private GPU process.

native-graphs retains upstream CUDA graphs, bypassing only depth decoder's
optional torch.compile step (which otherwise needs a Linux/Triton toolchain).
The graph class explicitly supports capturing uncompiled eager modules.
This adapter is qualified against upstream 6eba901d1845353802652c708a4740fdfc5baa75.
"""
import argparse
import sys
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--source',required=True)
parser.add_argument('--model',required=True)
parser.add_argument('--port',type=int,default=8871)
parser.add_argument('--acceleration',choices=['eager','native-graphs'],default='native-graphs')
args=parser.parse_args()
sys.path.insert(0,str(Path(args.source).resolve()))
import torch
torch.set_num_threads(6)
flags=['--no-fast-all']
if args.acceleration=='native-graphs':
    import models.fast_streaming as streaming
    class NativeDepthDecoderGraph(streaming.DepthDecoderGraph):
        def __init__(self,*a,**kw):
            kw['fast']=False
            super().__init__(*a,**kw)
    streaming.DepthDecoderGraph=NativeDepthDecoderGraph
    flags=['--fast-backbone-decode','--fast-depth-decoder']
from breeze_infer.api import main
sys.argv=['breeze-tts',args.model,'--host','127.0.0.1','--port',str(args.port),*flags]
main()
