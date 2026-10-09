bl_info = {"name":"阿男帮你推 · 画布桥接","author":"阿男帮你推","version":(1,4,0),"blender":(4,2,0),"location":"3D View > Sidebar > 阿男帮你推","category":"3D View"}
import base64,json,os,tempfile,threading,time,urllib.error,urllib.request,uuid,bpy
from bpy.props import BoolProperty,StringProperty
from bpy.types import Operator,Panel,PropertyGroup
BRIDGE="http://127.0.0.1:47777"; MAX_BYTES=24*1024*1024
_PENDING_RENDER={}
def vec(v): return [round(float(x),6) for x in v]
def data_url(path):
    with open(path,"rb") as f: raw=f.read()
    if len(raw)>MAX_BYTES: raise RuntimeError("图片超过 24MB，请降低渲染分辨率")
    return "data:image/png;base64,"+base64.b64encode(raw).decode()
def camera(scene):
    o=scene.camera
    if not o: raise RuntimeError("当前场景没有活动摄像机")
    c=o.data
    return {"name":o.name,"type":c.type,"lens":c.lens,"sensorWidth":c.sensor_width,"location":vec(o.matrix_world.translation),"rotation":vec(o.rotation_euler),"clipStart":c.clip_start,"clipEnd":c.clip_end,"orthoScale":c.ortho_scale,"dof":{"enabled":c.dof.use_dof,"focusDistance":c.dof.focus_distance,"fStop":c.dof.aperture_fstop}}
def lighting(scene):
    lights=[]
    for o in scene.objects:
        if o.type=='LIGHT': lights.append({"name":o.name,"type":o.data.type,"location":vec(o.matrix_world.translation),"rotation":vec(o.rotation_euler),"color":vec(o.data.color),"energy":o.data.energy,"size":getattr(o.data,"size",0.0)})
    return {"lights":lights,"world":{"color":vec(scene.world.color) if scene.world else [0,0,0]}}
def render_meta(scene):
    r=scene.render
    return {"engine":r.engine,"width":r.resolution_x,"height":r.resolution_y,"percentage":r.resolution_percentage,"filmTransparent":r.film_transparent}
def post(payload):
    request=urllib.request.Request(BRIDGE+"/api/blender-import",json.dumps(payload,ensure_ascii=False).encode(),{"Content-Type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(request,timeout=30) as response: return json.loads(response.read())
    except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode("utf-8","replace"))
    except OSError: raise RuntimeError("无法连接桌面端，请先启动阿男帮你推")
def capture(context,formal):
    scene=context.scene; r=scene.render
    if not scene.camera: raise RuntimeError("当前场景没有活动摄像机")
    old_path,old_format=r.filepath,r.image_settings.file_format
    f=tempfile.NamedTemporaryFile(suffix=".png",delete=False); path=f.name; f.close()
    try:
        r.filepath=path; r.image_settings.file_format='PNG'
        if formal: bpy.ops.render.render(write_still=True)
        else:
            if not context.space_data or context.space_data.type!='VIEW_3D': raise RuntimeError("请从 3D 视图侧栏执行")
            region=context.space_data.region_3d; old_view=region.view_perspective; region.view_perspective='CAMERA'
            try: bpy.ops.render.opengl(write_still=True,view_context=True)
            finally: region.view_perspective=old_view
        return data_url(path)
    finally:
        r.filepath, r.image_settings.file_format=old_path,old_format
        if os.path.exists(path): os.remove(path)
def payload(context,mode,rgb):
    s=context.scene; p=s.anan_bridge
    return {"schemaVersion":2,"id":str(uuid.uuid4()),"sourceType":mode,"createdAt":int(time.time()*1000),"sceneName":s.name,"blenderVersion":bpy.app.version_string,"imageDataUrl":rgb,"auxiliaryImages":{},"camera":camera(s),"lighting":lighting(s),"render":render_meta(s),"lockCamera":p.lock_camera,"lockLighting":p.lock_lighting,"useStructurePasses":p.use_structure_passes,"prompt":""}
def _set_status_later(scene_name,text):
    def update():
        scene=bpy.data.scenes.get(scene_name)
        if scene and hasattr(scene,"anan_bridge"): scene.anan_bridge.status=text
        return None
    bpy.app.timers.register(update,first_interval=0.01)
def _send_render_result(scene):
    task=_PENDING_RENDER.pop(scene.name,None)
    if not task: return
    f=tempfile.NamedTemporaryFile(suffix=".png",delete=False); path=f.name; f.close()
    try:
        result=bpy.data.images.get("Render Result")
        if not result: raise RuntimeError("Blender 没有生成 Render Result")
        result.save_render(path,scene=scene)
        task["imageDataUrl"]=data_url(path)
    except Exception as e:
        scene.anan_bridge.status="渲染完成，但读取失败："+str(e)
        if os.path.exists(path): os.remove(path)
        return
    if os.path.exists(path): os.remove(path)
    scene.anan_bridge.status="渲染完成，正在发送画布…"
    def worker():
        try: post(task); _set_status_later(scene.name,"发送成功，桌面端已自动聚焦")
        except Exception as e: _set_status_later(scene.name,"发送失败："+str(e))
    threading.Thread(target=worker,daemon=True).start()
def _cancel_render(scene):
    if _PENDING_RENDER.pop(scene.name,None): scene.anan_bridge.status="渲染已取消，未发送"
class ANAN_OT_check(Operator):
    bl_idname="anan.check"; bl_label="检查连接"
    def execute(self,context):
        try:
            with urllib.request.urlopen(BRIDGE+"/api/bridge-status",timeout=3) as r: info=json.loads(r.read())
            context.scene.anan_bridge.status="已连接 · "+info.get("target","当前活动项目"); return {'FINISHED'}
        except Exception: context.scene.anan_bridge.status="未连接：请启动桌面端"; return {'CANCELLED'}
class ANAN_OT_send(Operator):
    bl_idname="anan.send"; bl_label="导入画布"; formal:BoolProperty(default=False)
    def execute(self,context):
        p=context.scene.anan_bridge
        try:
            if self.formal:
                if context.scene.name in _PENDING_RENDER: raise RuntimeError("已有一个渲染导入任务正在执行")
                task=payload(context,"blender_render","")
                _PENDING_RENDER[context.scene.name]=task
                p.status="正在后台渲染；完成后将自动发送…"
                result=bpy.ops.render.render('INVOKE_DEFAULT')
                if 'CANCELLED' in result: _PENDING_RENDER.pop(context.scene.name,None); raise RuntimeError("Blender 无法启动渲染")
                return {'FINISHED'}
            p.status="正在捕获摄像机视口…"
            post(payload(context,"blender_viewport",capture(context,False)))
            p.status="发送成功，桌面端已自动聚焦"; return {'FINISHED'}
        except Exception as e: p.status="失败："+str(e); self.report({'ERROR'},str(e)); return {'CANCELLED'}
class ANAN_PT_panel(Panel):
    bl_label="阿男帮你推"; bl_idname="ANAN_PT_bridge"; bl_space_type='VIEW_3D'; bl_region_type='UI'; bl_category="阿男帮你推"
    def draw(self,context):
        l=self.layout; p=context.scene.anan_bridge
        l.label(text=p.status); l.operator("anan.check",icon='FILE_REFRESH'); l.prop(p,"lock_camera"); l.prop(p,"lock_lighting"); l.prop(p,"use_structure_passes")
        a=l.operator("anan.send",text="快速导入画布",icon='VIEW_CAMERA'); a.formal=False
        a=l.operator("anan.send",text="渲染并导入画布",icon='RENDER_STILL'); a.formal=True
        l.label(text="目标：桌面端当前活动项目")
        if p.use_structure_passes: l.label(text="兼容模式：使用文字强约束",icon='INFO')
class ANAN_Settings(PropertyGroup):
    lock_camera:BoolProperty(name="锁定摄像机",default=False); lock_lighting:BoolProperty(name="锁定光源",default=False); use_structure_passes:BoolProperty(name="增强结构约束",default=False); status:StringProperty(default="未检查连接")
CLASSES=(ANAN_Settings,ANAN_OT_check,ANAN_OT_send,ANAN_PT_panel)
def register():
    for c in CLASSES: bpy.utils.register_class(c)
    bpy.types.Scene.anan_bridge=bpy.props.PointerProperty(type=ANAN_Settings)
    if _send_render_result not in bpy.app.handlers.render_complete: bpy.app.handlers.render_complete.append(_send_render_result)
    if _cancel_render not in bpy.app.handlers.render_cancel: bpy.app.handlers.render_cancel.append(_cancel_render)
def unregister():
    if _send_render_result in bpy.app.handlers.render_complete: bpy.app.handlers.render_complete.remove(_send_render_result)
    if _cancel_render in bpy.app.handlers.render_cancel: bpy.app.handlers.render_cancel.remove(_cancel_render)
    _PENDING_RENDER.clear()
    del bpy.types.Scene.anan_bridge
    for c in reversed(CLASSES): bpy.utils.unregister_class(c)
