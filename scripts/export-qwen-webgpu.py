"""Export the SAME pinned official weights, with CPU reference parity.

Run with the unchanged official qwen-env. ONNX tooling lives in .qa/onnx-tools.
Decoder is FP32; learned text/codec embeddings and talker are FP16. No quantization.
Reference architecture: onnx-community revision 18b0bf898d211718bc33082fadc36a448e0cbc0c
(Apache-2.0), user_script.py. No reference code is executed by this script.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(".qa/onnx-tools").resolve()))
os.environ["HF_HUB_OFFLINE"]="1"
os.environ["TRANSFORMERS_OFFLINE"]="1"
import numpy as np
import onnx
import onnxruntime as ort
import torch

parser=argparse.ArgumentParser()
parser.add_argument("--component",choices=["decoder","embeddings","talker","predictor","predictor-step","cache","step","residual"],default="decoder")
args=parser.parse_args()
torch.set_num_threads(4)
torch.manual_seed(42)
meta=json.loads(Path(".qa/qwen-model-0.6b.json").read_text(encoding="utf-8"))
root=Path("public/models/qwen-webgpu");root.mkdir(parents=True,exist_ok=True)
model_path=Path(meta["localPath"])
records=[]

def export(model, inputs, name, names, outputs, axes=None):
    target=root/(name+".onnx")
    model.eval()
    tick=time.perf_counter()
    with torch.inference_mode():
        reference=model(*inputs)
        torch.onnx.export(model,inputs,str(target),input_names=names,output_names=outputs,
                          dynamic_axes=axes,opset_version=17,dynamo=False,do_constant_folding=True)
    graph=onnx.load(target)
    onnx.checker.check_model(graph)
    options=ort.SessionOptions();options.intra_op_num_threads=4
    session=ort.InferenceSession(str(target),sess_options=options,providers=["CPUExecutionProvider"])
    values=session.run(None,{n:v.cpu().numpy() for n,v in zip(names,inputs)})
    refs=reference if isinstance(reference,tuple) else (reference,)
    assert all(np.isfinite(a).all() and torch.isfinite(b).all() for a,b in zip(values,refs)), "Non-finite export/reference"
    errors=[float(np.max(np.abs(a-b.detach().cpu().numpy()))) for a,b in zip(values,refs)]
    record=dict(file=target.name,bytes=target.stat().st_size,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                operators=sorted(set(n.op_type for n in graph.graph.node)),exportSeconds=time.perf_counter()-tick,
                cpuMaxAbsError=errors,inputs=[dict(name=i.name,shape=i.shape,type=i.type) for i in session.get_inputs()])
    records.append(record)
    print(json.dumps(record),flush=True)
    # Save actual inputs/expected output for browser-side numerical parity.
    if name=="decoder":
        np.asarray(inputs[0],dtype="<i8").tofile(root/"decoder-input.i64")
        np.asarray(values[0],dtype="<f4").tofile(root/"decoder-reference.f32")
    return record

if args.component=="decoder":
    from qwen_tts.core.tokenizer_12hz.modeling_qwen3_tts_tokenizer_v2 import Qwen3TTSTokenizerV2Model
    tok=Qwen3TTSTokenizerV2Model.from_pretrained(str(model_path/"speech_tokenizer"),dtype=torch.float32,attn_implementation="eager")
    class Decoder(torch.nn.Module):
        def __init__(self, decoder):super().__init__();self.decoder=decoder
        def forward(self,codes):
            d=self.decoder
            # The browser supplies validated nonnegative codec IDs. Use int32
            # indices (no numeric quantization) and omit the redundant int Clip,
            # which the WebGPU EP cannot execute for int64 tensors.
            q=d.quantizer
            assert q.n_q_semantic == 1
            first=q.rvq_first.vq.layers[0].decode(codes.select(2,0))
            rest=q.rvq_rest.vq.layers[0].decode(codes.select(2,1))
            for index,layer in enumerate(q.rvq_rest.vq.layers[1:],start=2):
                rest=rest+layer.decode(codes.select(2,index))
            quantized=q.rvq_first.output_proj(first)+q.rvq_rest.output_proj(rest)
            hidden=d.pre_conv(quantized).transpose(1,2)
            length=hidden.shape[1]
            positions=torch.arange(length,device=hidden.device)
            causal=positions[:,None] >= positions[None,:]
            mask=torch.where(causal,0.0,torch.finfo(hidden.dtype).min).to(hidden.dtype)[None,None]
            masks={"full_attention":mask}
            if d.pre_transformer.has_sliding_layers:
                visible=causal & ((positions[:,None]-positions[None,:]) < d.pre_transformer.config.sliding_window)
                masks["sliding_attention"]=torch.where(visible,0.0,torch.finfo(hidden.dtype).min).to(hidden.dtype)[None,None]
            hidden=d.pre_transformer(inputs_embeds=hidden,attention_mask=masks).last_hidden_state.permute(0,2,1)
            for blocks in d.upsample:
                for block in blocks:hidden=block(hidden)
            for block in d.decoder:hidden=block(hidden)
            return hidden.clamp(-1,1)
    torch.manual_seed(42)
    codes=torch.randint(0,2048,(1,37,16),dtype=torch.int32)
    wrapped=Decoder(tok.decoder).eval()
    with torch.inference_mode():
        diff=float((wrapped(codes)-tok.decoder(codes.transpose(1,2))).abs().max())
        assert diff < 1e-5, f"Export mask changes decoder output: {diff}"
    export(wrapped,(codes,),"decoder",["audio_codes"],["waveform"])
else:
    from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSForConditionalGeneration
    model=Qwen3TTSForConditionalGeneration.from_pretrained(str(model_path),dtype=torch.float16,attn_implementation="eager")
    talker=model.talker
    if args.component=="embeddings":
        class Text(torch.nn.Module):
            def __init__(self):super().__init__();self.table=talker.get_text_embeddings();self.projection=talker.text_projection
            def forward(self,ids):
                p=self.projection;x=self.table(ids);dtype=x.dtype
                x=torch.nn.functional.linear(x.float(),p.linear_fc1.weight.float(),p.linear_fc1.bias.float() if p.linear_fc1.bias is not None else None).to(dtype)
                x=p.act_fn(x)
                return torch.nn.functional.linear(x.float(),p.linear_fc2.weight.float(),p.linear_fc2.bias.float() if p.linear_fc2.bias is not None else None).to(dtype)
        export(Text(),(torch.tensor([[1,2,3]]),),"text-embed",["text_ids"],["embeds"],{"text_ids":{1:"seq"},"embeds":{1:"seq"}})
        export(talker.model.codec_embedding,(torch.tensor([[1,2,3]]),),"codec-embed",["codec_ids"],["embeds"],{"codec_ids":{1:"seq"},"embeds":{1:"seq"}})
    elif args.component=="talker":
        class Talker(torch.nn.Module):
            def __init__(self):super().__init__();self.model=talker.model;self.head=talker.codec_head
            def forward(self,embeds,positions,mask):
                hidden=self.model(inputs_embeds=embeds,position_ids=positions,attention_mask=mask,use_cache=False,return_dict=True).last_hidden_state
                return self.head(hidden),hidden
        export(Talker(),(torch.randn(1,8,1024,dtype=torch.float16),torch.arange(8).view(1,1,8).expand(3,1,8).contiguous(),torch.triu(torch.full((1,1,8,8),-65504.,dtype=torch.float16),diagonal=1)),"talker-prefill",["embeds","positions","mask"],["logits","hidden"],
               {"embeds":{1:"seq"},"positions":{2:"seq"},"mask":{2:"seq",3:"seq"},"logits":{1:"seq"},"hidden":{1:"seq"}})
    elif args.component=="residual":
        class Residual(torch.nn.Module):
            def __init__(self):super().__init__();self.first=talker.model.codec_embedding;self.tables=talker.code_predictor.model.codec_embedding
            def forward(self,codes):
                result=self.first(codes[:,0])
                for i in range(15):result=result+self.tables[i](codes[:,i+1])
                return result
        export(Residual(),(torch.zeros(1,16,dtype=torch.int32),),"residual",["codes"],["embeds"])
    elif args.component in ("cache","step"):
        from transformers import DynamicCache
        class OfficialCachedTalker(torch.nn.Module):
            def __init__(self):super().__init__();self.model=talker.model;self.head=talker.codec_head
            def forward(self,embeds,positions,mask,*past):
                cache=DynamicCache.from_legacy_cache(tuple((past[i],past[i+1]) for i in range(0,56,2)))
                out=self.model(inputs_embeds=embeds,position_ids=positions,attention_mask=mask,past_key_values=cache,use_cache=True,return_dict=True)
                return (self.head(out.last_hidden_state),out.last_hidden_state,*[p for pair in out.past_key_values.to_legacy_cache() for p in pair])
        class CachedTalker(torch.nn.Module):
            """Same network without dynamic integer shape subgraphs.

            Batch is fixed to one, head counts are model constants, and sequence
            dimensions use one inferred reshape dimension. Text-only TTS uses
            equal temporal/height/width positions, so every MROPE section chooses
            the same frequency row. Official forward parity below is mandatory.
            """
            def __init__(self):
                super().__init__();self.model=talker.model;self.head=talker.codec_head
                self.register_buffer("repeated_heads",torch.arange(8).repeat_interleave(2))
            def forward(self,embeds,positions,mask,*past):
                slot=None
                if args.component=="step":slot=past[0];past=past[1:]
                frequencies=self.model.rotary_emb.inv_freq.float().reshape(1,64,1) @ positions.select(0,0).float().reshape(1,1,-1)
                frequencies=frequencies.transpose(1,2)
                angles=torch.cat((frequencies,frequencies),dim=-1)
                cos=(angles.cos()*self.model.rotary_emb.attention_scaling).to(embeds.dtype).unsqueeze(1)
                sin=(angles.sin()*self.model.rotary_emb.attention_scaling).to(embeds.dtype).unsqueeze(1)
                hidden=embeds; present=[]
                for index,layer in enumerate(self.model.layers):
                    residual=hidden
                    x=layer.input_layernorm(hidden);a=layer.self_attn
                    query=a.q_norm(a.q_proj(x).reshape(1,-1,16,128)).transpose(1,2)
                    key=a.k_norm(a.k_proj(x).reshape(1,-1,8,128)).transpose(1,2)
                    value=a.v_proj(x).reshape(1,-1,8,128).transpose(1,2)
                    query=query*cos+torch.cat((-query[:,:,:,64:],query[:,:,:,:64]),dim=-1)*sin
                    key=key*cos+torch.cat((-key[:,:,:,64:],key[:,:,:,:64]),dim=-1)*sin
                    if slot is None:
                        key=torch.cat((past[2*index],key),dim=2)
                        value=torch.cat((past[2*index+1],value),dim=2)
                    else:
                        key=past[2*index]*(1-slot)+key*slot
                        value=past[2*index+1]*(1-slot)+value*slot
                    present.extend((key,value))
                    repeated_key=key.index_select(1,self.repeated_heads)
                    repeated_value=value.index_select(1,self.repeated_heads)
                    scores=(query.float() @ repeated_key.float().transpose(2,3)).to(query.dtype)*a.scaling+mask
                    weights=torch.nn.functional.softmax(scores,dim=-1,dtype=torch.float32).to(query.dtype)
                    output=(weights.float() @ repeated_value.float()).to(query.dtype).transpose(1,2).reshape(1,-1,2048)
                    hidden=residual+a.o_proj(output)
                    hidden=hidden+layer.mlp(layer.post_attention_layernorm(hidden))
                hidden=self.model.norm(hidden)
                return (self.head(hidden),hidden,*present)
        names=["embeds","positions","mask"]+[f"past_{i}" for i in range(56)]
        outputs=["logits","hidden"]+[f"present_{i}" for i in range(56)]
        axes={"embeds":{1:"cur"},"positions":{2:"cur"},"mask":{2:"cur",3:"total"},"logits":{1:"cur"},"hidden":{1:"cur"}}
        for i in range(56):axes[f"past_{i}"]={2:"past"};axes[f"present_{i}"]={2:"total"}
        inputs=(torch.randn(1,8,1024,dtype=torch.float16),torch.arange(4,12,dtype=torch.int32).view(1,1,8).expand(3,1,8).contiguous(),torch.triu(torch.full((1,1,8,12),-65504.,dtype=torch.float16),diagonal=5),
                *[torch.zeros(1,8,4,128,dtype=torch.float16) for _ in range(56)])
        if args.component=="step":
            slot=torch.zeros(1,1,2048,1,dtype=torch.float16);slot[:,:,4]=1
            mask=torch.full((1,1,1,2048),-65504.,dtype=torch.float16);mask[:,:,:,1:5]=0
            inputs=(torch.randn(1,1,1024,dtype=torch.float16),torch.full((3,1,1),3,dtype=torch.int32),mask,slot,
                    *[torch.zeros(1,8,2048,128,dtype=torch.float16) for _ in range(56)])
            with torch.inference_mode():
                actual=CachedTalker()(*inputs)
                reference=OfficialCachedTalker()(inputs[0],inputs[1],mask[:,:,:,:5],*[p[:,:,:4,:] for p in inputs[4:]])
                diff=max(float((a-b).abs().max()) for a,b in zip(actual[:2],reference[:2]))
                print("STATIC_TALKER_OFFICIAL_MAX_ERROR",diff,flush=True)
                assert diff < .1, diff
            export(CachedTalker(),inputs,"talker-step",names[:3]+["slot"]+names[3:],outputs)
        else:
          with torch.inference_mode():
            actual=CachedTalker()(*inputs);reference=OfficialCachedTalker()(*inputs)
            error=max(float((a-b).abs().max()) for a,b in zip(actual,reference))
            print("SHAPE_FREE_TALKER_OFFICIAL_MAX_ERROR",error,flush=True)
            # FP32 attention accumulation intentionally differs from the pure
            # half reference. Gate it against the official FP32 network too.
            saved_buffers={name:value.detach().clone() for name,value in model.named_buffers()}
            official=OfficialCachedTalker().float()
            full=official(*[x.float() if x.is_floating_point() else x for x in inputs])
            similarities=[float(torch.nn.functional.cosine_similarity(a.float().flatten(),b.float().flatten(),dim=0)) for a,b in zip(actual[:2],full[:2])]
            print("FP32_OFFICIAL_LOGIT_HIDDEN_COSINE",similarities,flush=True)
            assert min(similarities) > .999, similarities
            model.half()
            for name,value in saved_buffers.items():
                path,field=name.rsplit(".",1)
                model.get_submodule(path)._buffers[field]=value
          export(CachedTalker(),inputs,"talker-cache",names,outputs,axes)
    else:
        class StableMLP(torch.nn.Module):
            def __init__(self,mlp):
                super().__init__();self.gate_proj=mlp.gate_proj;self.up_proj=mlp.up_proj;self.down_proj=mlp.down_proj;self.act_fn=mlp.act_fn
            def forward(self,x):
                # Real CustomVoice hidden states overflow the FP16 SwiGLU
                # product in predictor layer 2, including official PyTorch.
                # Keep the product and its reduction FP32, then return FP16.
                product=self.act_fn(self.gate_proj(x)).float()*self.up_proj(x).float()
                return torch.nn.functional.linear(product,self.down_proj.weight.float(),None).to(x.dtype)
        for layer in talker.code_predictor.model.layers:layer.mlp=StableMLP(layer.mlp)
        class Predictor(torch.nn.Module):
            def __init__(self):
                super().__init__();self.cp=talker.code_predictor;self.embed=talker.model.codec_embedding
            def forward(self,hidden,codes):
                parts=[hidden.unsqueeze(1),self.embed(codes.select(1,0).unsqueeze(1))]
                for i in range(1,15):parts.append(self.cp.model.codec_embedding[i-1](codes.select(1,i).unsqueeze(1)))
                embeds=self.cp.small_to_mtp_projection(torch.cat(parts,dim=1))
                mask=torch.triu(torch.full((1,1,16,16),-65504.,dtype=embeds.dtype,device=embeds.device),diagonal=1)
                h=self.cp.model(inputs_embeds=embeds,attention_mask=mask,use_cache=False,return_dict=True).last_hidden_state
                return torch.stack([self.cp.lm_head[i-1](h[:,i]) for i in range(1,16)],dim=1)
        reference_hidden=torch.from_numpy(np.fromfile(root/"hidden-Serena.f16",dtype=np.float16).reshape(1,1024))
        reference_codes=torch.zeros(1,16,dtype=torch.int32);reference_codes[0,0]=1995
        if args.component=="predictor":
            export(Predictor(),(reference_hidden,reference_codes),"predictor",["hidden","codes"],["logits"])
        else:
            class PredictorStep(torch.nn.Module):
                def __init__(self):
                    super().__init__();self.cp=talker.code_predictor
                    self.register_buffer("tables",torch.cat([m.weight for m in self.cp.model.codec_embedding],dim=0))
                    self.register_buffer("heads",torch.stack([m.weight for m in self.cp.lm_head]))
                    self.register_buffer("repeated_heads",torch.arange(8).repeat_interleave(2))
                def forward(self,embeds,embedding_id,use_input,head,position,mask,slot,*past):
                    lookup=torch.nn.functional.embedding(embedding_id,self.tables).reshape(1,1,1024)
                    hidden=self.cp.small_to_mtp_projection(embeds*use_input+lookup*(1-use_input))
                    angles=position.float().reshape(1,1,1)*self.cp.model.rotary_emb.inv_freq.float().reshape(1,1,64)
                    angles=torch.cat((angles,angles),dim=-1)
                    cos=(angles.cos()*self.cp.model.rotary_emb.attention_scaling).to(hidden.dtype).unsqueeze(1)
                    sin=(angles.sin()*self.cp.model.rotary_emb.attention_scaling).to(hidden.dtype).unsqueeze(1)
                    present=[]
                    for i,layer in enumerate(self.cp.model.layers):
                        residual=hidden;x=layer.input_layernorm(hidden);a=layer.self_attn
                        query=a.q_norm(a.q_proj(x).reshape(1,1,16,128)).transpose(1,2)
                        key=a.k_norm(a.k_proj(x).reshape(1,1,8,128)).transpose(1,2)
                        value=a.v_proj(x).reshape(1,1,8,128).transpose(1,2)
                        query=query*cos+torch.cat((-query[:,:,:,64:],query[:,:,:,:64]),dim=-1)*sin
                        key=key*cos+torch.cat((-key[:,:,:,64:],key[:,:,:,:64]),dim=-1)*sin
                        key=past[2*i]*(1-slot)+key*slot;value=past[2*i+1]*(1-slot)+value*slot
                        present.extend((key,value))
                        score=(query @ key.index_select(1,self.repeated_heads).transpose(2,3))*a.scaling+mask
                        attention=torch.nn.functional.softmax(score,dim=-1,dtype=torch.float32).to(query.dtype)
                        out=(attention @ value.index_select(1,self.repeated_heads)).transpose(1,2).reshape(1,1,2048)
                        hidden=residual+a.o_proj(out)
                        hidden=hidden+layer.mlp(layer.post_attention_layernorm(hidden))
                    hidden=self.cp.model.norm(hidden)
                    head_weight=self.heads.index_select(0,head).squeeze(0)
                    return (torch.nn.functional.linear(hidden,head_weight),*present)
            step=PredictorStep().eval()
            cache=[torch.zeros(1,8,16,128,dtype=torch.float16) for _ in range(10)]
            outputs=[]
            with torch.inference_mode():
                full=Predictor()(reference_hidden,reference_codes)
                for pos in range(16):
                    embeds=reference_hidden.unsqueeze(1) if pos==0 else talker.model.codec_embedding(reference_codes[:,0]).unsqueeze(1)
                    mask=torch.full((1,1,1,16),-65504.,dtype=torch.float16);mask[:,:,:,:pos+1]=0
                    slot=torch.zeros(1,1,16,1,dtype=torch.float16);slot[:,:,pos]=1
                    inputs=(embeds,torch.tensor([max(0,pos-2)*2048],dtype=torch.int32),torch.tensor([[[float(pos<2)]]],dtype=torch.float16),torch.tensor([max(0,pos-1)],dtype=torch.int32),torch.tensor([pos],dtype=torch.int32),mask,slot,*cache)
                    result=step(*inputs);cache=list(result[1:])
                    if pos: outputs.append(result[0])
                actual=torch.cat(outputs,dim=1)
                assert torch.isfinite(actual).all()
                diff=float((actual-full).abs().max());print("PREDICTOR_STEP_FULL_PARITY",diff,flush=True)
                assert diff < .3, diff
            names=["embeds","embedding_id","use_input","head","position","mask","slot"]+[f"past_{i}" for i in range(10)]
            export(step,inputs,"predictor-step",names,["logits"]+[f"present_{i}" for i in range(10)])

report=root/(args.component+"-export.json")
report.write_text(json.dumps(dict(source=meta,component=args.component,records=records),indent=2),encoding="utf-8")
if args.component=="decoder":
    (root/"manifest.json").write_text(json.dumps(dict(version=meta["revision"]+"-decoder-fp32-37-v1",source=meta["repo"],revision=meta["revision"],
        probeModel="/models/qwen-webgpu/decoder.onnx",modelBytes=records[0]["bytes"],sha256=records[0]["sha256"],
        status="decoder-probe-only",generatorPrecision="fp16",decoderPrecision="fp32",frames=37),indent=2),encoding="utf-8")
