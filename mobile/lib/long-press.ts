let suppressUntil = 0;
export const suppressDragClick = () => Date.now() < suppressUntil;
type Drop = { id: string; direction: -1 | 1 };
type Options = {
  canDrop: (source: string, target: string) => boolean;
  onDrop: (source: string, target: string, direction: -1 | 1) => void;
  announce: (message: string) => void;
};

// Touch listeners remain passive until pickup; an ordinary swipe still scrolls.
export function attachLongPress(list: HTMLElement, options: Options) {
  let pending: { id: string; row: HTMLElement; x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false, ghost: HTMLElement | null = null, drop: Drop | null = null;
  let y = 0, offset = 0, frame = 0;
  let slots: {row: HTMLElement; top: number; height: number}[] = [];
  let landingTop = 0, settling = false, epoch = 0;
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const clearPreview = () => {for (const {row} of slots) {row.style.transform = "";row.classList.remove("drag-neighbor");}slots=[];};
  function locate() {
    if (!pending) return;
    const eligible = slots.filter(slot => slot.row !== pending!.row && options.canDrop(pending!.id,slot.row.dataset.taskId!));
    const pageY = y + window.scrollY;
    const target = eligible.find(slot => pageY < slot.top + slot.height/2);
    const slot = target || eligible.at(-1);
    if (!slot) return;
    drop = {id:slot.row.dataset.taskId!,direction:target?-1:1};
    const ordered = slots.filter(s=>s.row!==pending!.row);
    const source = slots.find(s=>s.row===pending!.row)!;
    ordered.splice(ordered.indexOf(slot)+(target?0:1),0,source);
    let top = slots[0].top;
    for (const item of ordered) {
      item.row.style.transform = `translateY(${top-item.top}px)`;
      if (item===source) landingTop=top;
      top+=item.height;
    }
  }
  function animate() {
    if (!active || !ghost) return;
    ghost.style.top = `${y-offset}px`;
    const edge = 70, height = window.innerHeight;
    const speed = y < edge ? -Math.min(14,(edge-y)/4) : y > height-edge ? Math.min(14,(y-height+edge)/4) : 0;
    if (speed) window.scrollBy(0,speed);
    locate();
    frame = requestAnimationFrame(animate);
  }
  function finish(commit = false) {
    clearTimeout(timer); cancelAnimationFrame(frame); frame = 0;
    const source = pending?.id, destination = drop, wasActive = active;
    const currentEpoch = ++epoch;
    if (wasActive) suppressUntil = Date.now()+700;
    active=false;
    const complete = () => {
      if(currentEpoch!==epoch)return;
      pending?.row.classList.remove("is-dragging");
      ghost?.remove(); ghost=null; pending=null; drop=null; settling=false;
      clearPreview(); document.body.classList.remove("task-drag-active");
      if(wasActive&&commit&&source&&destination)options.onDrop(source,destination.id,destination.direction);
      else if(wasActive)options.announce(commit?"Task stayed in place.":"Reordering cancelled.");
    };
    if(wasActive&&commit&&ghost?.animate&&!reduced()) {
      settling=true;
      const animation=ghost.animate([
        {top:ghost.style.top,transform:"scale(1.025)",opacity:1},
        {top:`${landingTop-window.scrollY}px`,transform:"scale(1)",opacity:1}
      ],{duration:180,easing:"cubic-bezier(.2,.8,.2,1)",fill:"forwards"});
      void animation.finished.then(complete,complete);
    } else complete();
  }
  function start(target: EventTarget | null, x: number, nextY: number) {
    if (settling) return;
    if (!(target instanceof Element) || target.closest("a,.tick")) return;
    const row = target.closest<HTMLElement>("[data-task-id]");
    if (!row || !list.contains(row)) return;
    finish(); y = nextY;
    pending = { id: row.dataset.taskId!, row, x, y };
    timer = setTimeout(() => {
      if (!pending) return;
      active = true;
      slots=[...list.querySelectorAll<HTMLElement>("[data-task-id]")].map(row=>{
        const box=row.getBoundingClientRect();return {row,top:box.top+window.scrollY,height:box.height};
      });
      for(const {row} of slots)row.classList.add("drag-neighbor");
      landingTop=row.getBoundingClientRect().top+window.scrollY;
      const box = row.getBoundingClientRect(); offset = y-box.top;
      ghost = row.cloneNode(true) as HTMLElement;
      ghost.classList.add("task-drag-ghost"); ghost.setAttribute("aria-hidden","true"); ghost.inert = true;
      Object.assign(ghost.style,{width:`${box.width}px`,left:`${box.left}px`,top:`${box.top}px`});
      ghost.classList.remove("drag-neighbor");
      document.body.append(ghost); row.classList.add("is-dragging");
      if(!reduced())ghost.animate?.([{transform:"scale(1)"},{transform:"scale(1.025)"}],{duration:160,easing:"ease-out"});
      document.body.classList.add("task-drag-active");
      options.announce("Task picked up. Drag to a new position and release.");
      // No drop destination until the finger actually moves.
    },400);
  }
  function move(x: number, nextY: number, event: Event) {
    if (!pending) return;
    if (!active) {
      if (Math.hypot(x-pending.x,nextY-pending.y)>10) finish();
      return;
    }
    if (event.cancelable) event.preventDefault();
    y = nextY;
    if (!frame) animate();
  }
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length!==1) { finish(); return; }
    const touch=event.touches[0]; start(event.target,touch.clientX,touch.clientY);
  };
  const touchMove = (event: TouchEvent) => {
    if(event.touches.length!==1){finish();return;}
    const touch=event.touches[0];move(touch.clientX,touch.clientY,event);
  };
  const touchEnd = () => finish(true);
  const cancel = () => finish();
  const pointerDown = (event: PointerEvent) => {if(event.pointerType!=="touch"&&event.button===0)start(event.target,event.clientX,event.clientY);};
  const pointerMove = (event: PointerEvent) => {if(event.pointerType!=="touch")move(event.clientX,event.clientY,event);};
  const pointerUp = (event: PointerEvent) => {if(event.pointerType!=="touch")finish(true);};
  const pointerCancel = (event: PointerEvent) => {if(event.pointerType!=="touch")finish();};
  const click = (event: MouseEvent) => {if(active||Date.now()<suppressUntil){event.preventDefault();event.stopPropagation();}};
  const context = (event: Event) => {if(pending)event.preventDefault();};
  const key = (event: KeyboardEvent) => {if(event.key==="Escape")finish();};
  list.addEventListener("touchstart",touchStart,{passive:true});
  document.addEventListener("touchmove",touchMove,{passive:false});
  document.addEventListener("touchend",touchEnd);
  document.addEventListener("touchcancel",cancel);
  list.addEventListener("pointerdown",pointerDown);
  document.addEventListener("pointermove",pointerMove);
  document.addEventListener("pointerup",pointerUp);
  document.addEventListener("pointercancel",pointerCancel);
  list.addEventListener("click",click,true);
  list.addEventListener("contextmenu",context);
  document.addEventListener("keydown",key);
  window.addEventListener("blur",cancel);
  return () => {
    finish();
    list.removeEventListener("touchstart",touchStart);
    document.removeEventListener("touchmove",touchMove);
    document.removeEventListener("touchend",touchEnd);
    document.removeEventListener("touchcancel",cancel);
    list.removeEventListener("pointerdown",pointerDown);
    document.removeEventListener("pointermove",pointerMove);
    document.removeEventListener("pointerup",pointerUp);
    document.removeEventListener("pointercancel",pointerCancel);
    list.removeEventListener("click",click,true);
    list.removeEventListener("contextmenu",context);
    document.removeEventListener("keydown",key);
    window.removeEventListener("blur",cancel);
  };
}
