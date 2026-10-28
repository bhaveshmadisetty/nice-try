"use client";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Plus, Check, ChevronRight, X, CalendarDays, Link2, AlarmClock, RefreshCw, Smartphone, Download, Upload } from "lucide-react";
import * as service from "../lib/task-service";
import { attachLongPress, suppressDragClick } from "../lib/long-press";
import { moveTask, taskLink, compareRank, completionTiming, parseLink, textParts, due as deadline } from "../lib/task-list";
import type { Task, View } from "../lib/task-service";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const dateLabel = (date?: string) => !date || date === today() ? "Today" : new Date(date + "T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"});
// Apply the link field to a task: a valid link sets url+host (the fields the
// extension reads), an empty field removes both.
function withLink(task:Task,raw:string):Task{
  const link=parseLink(raw);
  if(link===null)throw Error("That link doesn't look like a web address.");
  const {url:_url,host:_host,...rest}=task;
  return link?{...rest,url:link.url,host:link.host}:rest as Task;
}
// Apply the deadline fields: a day (and optional time) sets `due`, blank clears it.
function withDue(task:Task,day:string,time:string):Task{
  if(time&&!day)throw Error("Pick a deadline day for that time.");
  const {due:_due,...rest}=task;
  const value=deadline.join(day,time);
  return value?{...rest,due:value}:rest as Task;
}
const dueFields=(task:Task)=>{const p=deadline.parse(task.due);return p?{day:String(task.due).slice(0,10),time:p.time}:{day:"",time:""};};
function download(text:string) {
  const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));
  const a=document.createElement("a"); a.href=url; a.download=`nice-try-tasks-${today()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function Home() {
  const [view,setView]=useState<View>({tasks:[],email:"",status:"Opening your tasks…",ready:false,busy:false,owner:"guest",recoverableCount:0,signedOut:false});
  const [tab,setTab]=useState("today"),[search,setSearch]=useState(""),[text,setText]=useState(""),[date,setDate]=useState(""),[link,setLink]=useState(""),[showLink,setShowLink]=useState(false),[dueDay,setDueDay]=useState(""),[dueTime,setDueTime]=useState(""),[showDue,setShowDue]=useState(false);
  const [account,setAccount]=useState(false),[importLocal,setImportLocal]=useState(false),[error,setError]=useState(""),[saving,setSaving]=useState(false);
  const [edit,setEdit]=useState<{task:Task;base:Task[];owner:string}|null>(null),[editText,setEditText]=useState(""),[editDate,setEditDate]=useState(""),[editLink,setEditLink]=useState(""),[editDueDay,setEditDueDay]=useState(""),[editDueTime,setEditDueTime]=useState("");
  const [orderMessage,setOrderMessage]=useState("");
  const [installed,setInstalled]=useState(false);
  const [install,setInstall]=useState<{prompt():Promise<void>;userChoice:Promise<{outcome:string}>}|null>(null);
  const taskList=useRef<HTMLUListElement>(null);
  const dialog=useRef<HTMLDialogElement>(null),importInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const unsubscribe=service.subscribe(setView); void service.start(); setDate(today());
    const displayMode=window.matchMedia("(display-mode: standalone)");
    const checkInstalled=()=>setInstalled(displayMode.matches || (navigator as Navigator & {standalone?:boolean}).standalone===true || localStorage.getItem("nice-try.installed")==="1");
    const onInstalled=()=>{localStorage.setItem("nice-try.installed","1");setInstalled(true);setInstall(null);};
    checkInstalled();
    displayMode.addEventListener("change",checkInstalled);
    window.addEventListener("appinstalled",onInstalled);
    const listener=(e:Event)=>{e.preventDefault();localStorage.removeItem("nice-try.installed");setInstalled(false);setInstall(e as unknown as typeof install);};
    window.addEventListener("beforeinstallprompt",listener);
    return ()=>{unsubscribe();window.removeEventListener("beforeinstallprompt",listener);window.removeEventListener("appinstalled",onInstalled);displayMode.removeEventListener("change",checkInstalled);};
  },[]);
  useEffect(()=>{if(edit)dialog.current?.showModal();else dialog.current?.close();},[edit]);
  async function act(fn:()=>Promise<unknown>){setError("");setSaving(true);try{await fn();}catch(e){setError((e as Error).message);}finally{setSaving(false);}}
  const open=view.tasks.filter(t=>!t.done),done=view.tasks.filter(t=>t.done),due=open.filter(t=>!t.date||t.date<=today());
  const visible=view.tasks.filter(t=>search?t.text.toLowerCase().includes(search.toLowerCase()):tab==="today"?!t.done&&(!t.date||t.date<=today()):tab==="upcoming"?!t.done&&!!t.date&&t.date>today():tab==="done"?t.done:true)
    .sort((a,b)=>Number(a.done)-Number(b.done)||(tab==="upcoming"?(a.date||"").localeCompare(b.date||""):0)||compareRank(a,b));
  useEffect(()=>{
    if (!taskList.current || saving || !view.ready || search || account) return;
    return attachLongPress(taskList.current, {
      canDrop: (id,targetId)=>{
        const source=view.tasks.find(t=>t.id===id),target=view.tasks.find(t=>t.id===targetId);
        return !!source&&!!target&&source.done===target.done&&(tab!=="upcoming"||source.date===target.date);
      },
      announce:setOrderMessage,
      onDrop:(id,targetId,direction)=>{void act(async()=>{
        await service.save(view.tasks,moveTask(view.tasks,id,targetId,direction),view.owner);
        setOrderMessage("Task order saved.");
      });}
    });
  },[view.tasks,view.owner,view.ready,saving,search,tab,account]);
  async function toggle(task:Task){const next={...task,done:!task.done};if(next.done)next.doneDate=today();else delete next.doneDate;await service.save(view.tasks,view.tasks.map(t=>t.id===task.id?next:t),view.owner);}
  if(account) return <main className="app account-screen">
<nav className="account-nav"><button className="quiet" onClick={()=>setAccount(false)}>&lsaquo; Tasks</button><span>Nice Try</span></nav>
<section className="profile-hero"><div className="profile-avatar">{view.email?view.email.charAt(0).toUpperCase():<img src="/logo-mark.png" alt="" width="48" height="48"/>}</div><p className="eyebrow">YOUR ACCOUNT</p><h1>{view.email&&!view.signedOut?"You're connected.":view.email?"Sign in to sync.":"Your focus, everywhere."}</h1><p className="profile-email">{view.email||"One task list. Phone and browser."}</p>{view.email&&!view.signedOut&&<span className="account-pill"><span className="dot connected"/>Google account connected</span>}</section>
{error&&<p className="error" role="alert">{error}</p>}
{view.email&&!view.signedOut&&view.recoverableCount>0&&<section className="account-panel recovery-panel"><div><h2>{view.recoverableCount} local task{view.recoverableCount===1?"":"s"} still on this phone</h2><p>Restore them to this account. Existing account edits and deletions are kept.</p></div><button disabled={saving||view.busy} onClick={()=>act(async()=>{const count=await service.recoverGuestTasks();if(!count)throw Error("No local tasks need restoring.");})}>{saving?"Restoring...":"Restore local tasks"}</button></section>}
{view.email&&!view.signedOut?<><section className="account-panel sync-panel"><div className="section-icon"><RefreshCw size={21} className={view.busy?"spin":""}/></div><div className="sync-copy"><h2>Task sync</h2><p role="status">{view.status}</p></div><button className="quiet" disabled={saving||view.busy} onClick={()=>act(service.sync)}>{view.busy?"Syncing...":"Sync now"}</button></section><button className="continue-tasks" onClick={()=>setAccount(false)}>Back to your tasks<ChevronRight size={18}/></button></>:<section className="account-panel">{view.signedOut&&<p>Your saved tasks are still here. Sign in with {view.email} to sync them again.</p>}<label className="check-label"><input type="checkbox" checked={importLocal} onChange={e=>setImportLocal(e.target.checked)}/>Include tasks saved on this phone</label><button className="continue-tasks" disabled={!service.configured||saving||!view.ready} onClick={()=>act(()=>service.connect(importLocal))}>{saving?"Connecting...":"Continue with Google"}</button>{!service.configured&&<p>Sign-in is temporarily unavailable.</p>}</section>}
<details className="account-panel backup-panel"><summary>Backup & account</summary><div className="backup-actions"><button className="quiet" disabled={!view.ready} onClick={()=>download(service.exportTasks())}><Download size={17}/>Export tasks</button><button className="quiet" disabled={!view.ready||saving} onClick={()=>importInput.current?.click()}><Upload size={17}/>Import tasks</button>{view.email&&<button className="quiet danger" disabled={saving} onClick={()=>act(service.disconnect)}>Sign out</button>}</div><p className="fine">Only tasks sync. Your browsing history stays on your device.</p></details>
<input ref={importInput} type="file" accept="application/json,.json" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value="";if(file)void act(async()=>{if(file.size>5_000_000)throw Error("Choose a task export smaller than 5 MB.");await service.importTasks(await file.text());});}}/>
</main>;
  return <main className="app">
    <header className="topbar"><a className="brand" href="/"><img className="brand-logo" src="/logo-mark.png" alt="" width="40" height="40"/><span>Nice Try<span className="brand-sub">DAILY FOCUS</span></span></a><button className="account-button" aria-expanded={account} onClick={()=>setAccount(!account)}>{view.email&&!view.signedOut?view.email.split("@")[0]:"Sign in"}<ChevronRight size={16}/></button></header>

    <section className="heading"><div><p className="eyebrow">YOUR DAILY FOCUS</p><h1>{tab==="upcoming"?"Upcoming":tab==="done"?"Completed":tab==="all"?"All tasks":"Today's focus"}</h1><p className="intro">{due.length?`${due.length} ${due.length===1?"task needs":"tasks need"} your attention today.`:"A clear day starts with a small intention."}</p></div><div className="tally"><strong>{String(done.length).padStart(2,"0")}</strong><span>completed</span></div></section>
    <div className="connection"><span className={view.email&&!view.signedOut?"dot connected":"dot"}/><span role="status">{view.status}</span>{view.email&&!view.signedOut&&<button className="icon-button" aria-label="Sync tasks now" disabled={saving||view.busy} onClick={()=>act(service.sync)}><RefreshCw size={16} className={view.busy?"spin":""}/></button>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    <form className="composer" onSubmit={e=>{e.preventDefault();if(!text.trim()&&!link.trim())return;void act(async()=>{const parsed=parseLink(link);const next=withDue(withLink({id:crypto.randomUUID(),text:text.trim()||(parsed?parsed.host:""),done:false,date:date||today(),rank:Math.max(0,...view.tasks.map(t=>t.rank||0))+1024},link),dueDay,dueTime);await service.save(view.tasks,[...view.tasks,next],view.owner);setText("");setLink("");setShowLink(false);setDueDay("");setDueTime("");setShowDue(false);});}}>
      <label className="sr-only" htmlFor="taskText">New task</label><input id="taskText" value={text} onChange={e=>setText(e.target.value)} placeholder="What will you work on?" maxLength={4000} disabled={!view.ready||saving}/>
      {showLink&&<><label className="sr-only" htmlFor="taskLink">Link</label><input id="taskLink" className="link-input" type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={link} onChange={e=>setLink(e.target.value)} placeholder="Paste a link" maxLength={2000} disabled={!view.ready||saving}/></>}
      {showDue&&<div className="due-fields"><span>Deadline</span><input aria-label="Deadline day" type="date" value={dueDay} onChange={e=>setDueDay(e.target.value)} disabled={!view.ready||saving}/><input aria-label="Deadline time (optional)" type="time" value={dueTime} onChange={e=>setDueTime(e.target.value)} disabled={!view.ready||saving}/></div>}
      <div className="composer-actions"><button type="button" className={showLink?"link-toggle selected":"link-toggle"} aria-label={showLink?"Remove link field":"Add a link"} aria-pressed={showLink} onClick={()=>{if(showLink)setLink("");setShowLink(!showLink);}}><Link2 size={17}/></button><button type="button" className={showDue?"link-toggle selected":"link-toggle"} aria-label={showDue?"Remove deadline":"Add a deadline"} aria-pressed={showDue} onClick={()=>{if(showDue){setDueDay("");setDueTime("");}setShowDue(!showDue);}}><AlarmClock size={17}/></button><label className="date-input"><CalendarDays size={17}/><input aria-label="Task date" type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label><button className="add" type="submit" disabled={!view.ready||saving||(!text.trim()&&!link.trim())}><Plus size={20}/><span>Add task</span></button></div></form>
    <nav className="tabs" aria-label="Task views">{[["today","Today",due.length],["upcoming","Upcoming",open.length-due.length],["all","All tasks",view.tasks.length],["done","Done",done.length]].map(([key,name,count])=><button key={key} className={tab===key?"selected":""} aria-pressed={tab===key} onClick={()=>setTab(String(key))}>{name}<span>{count}</span></button>)}</nav>
    <div className="list-top"><h2>{search?"Search results":tab==="today"?"Your focus":tab==="upcoming"?"Coming up":tab==="done"?"Finished":"Everything"}</h2><input type="search" aria-label="Search all tasks" placeholder="Find a task" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    <p className="reorder-hint" id="reorderHint">{search?"Clear search to reorder tasks.":"Touch and hold a task to move it."}</p>
    <span className="sr-only" role="status">{orderMessage}</span>
    <ul className="task-list" ref={taskList} aria-describedby="reorderHint" onClickCapture={e=>{if(suppressDragClick()){e.preventDefault();e.stopPropagation();}}}>{visible.map((task,i)=>{
      const attached=task.url?taskLink({...task,text:""}):null;
      const openEdit=()=>{if(!view.ready)return;setError("");setEdit({task,base:structuredClone(view.tasks),owner:view.owner});setEditText(task.text);setEditDate(task.date||today());setEditLink(task.url||"");const f=dueFields(task);setEditDueDay(f.day);setEditDueTime(f.time);};
      const dueOf=!task.done?deadline.info(task.due):null;
      const canMove=(direction:number)=>{const neighbor=visible[i+direction];return !!neighbor && neighbor.done===task.done && (tab!=="upcoming"||neighbor.date===task.date);};
      return <li className={task.done?"task done":"task"} key={task.id} data-task-id={task.id}>
        <button className="tick" aria-label={`${task.done?"Reopen":"Complete"}: ${task.text}`} aria-pressed={task.done} disabled={saving||!view.ready} onClick={()=>act(()=>toggle(task))}>{task.done&&<Check size={18}/>}</button>
        <div className="task-content"><div className="task-main" role="button" tabIndex={0} aria-disabled={!view.ready} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={e=>{
          if(e.target===e.currentTarget&&(e.key==="Enter"||e.key===" ")){e.preventDefault();openEdit();return;}
          if(!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key)||search||saving)return;
          e.preventDefault();const direction=e.key==='ArrowUp'?-1:1;
          if(canMove(direction))void act(async()=>{await service.save(view.tasks,moveTask(view.tasks,task.id,visible[i+direction].id,direction),view.owner);setOrderMessage(`Moved ${task.text} ${direction<0?'up':'down'}.`);});
        }} onClick={openEdit}><span className="task-text">{textParts(task.text).map((part,n)=>part.href?<a key={n} className="inline-link" href={part.href} target="_blank" rel="noreferrer noopener" onClick={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>{part.text}</a>:part.text)}</span><span className="task-meta">{task.done?`Completed ${dateLabel(task.doneDate||task.date)}${task.date?` · Planned ${dateLabel(task.date)}`:""}${completionTiming(task)?` · ${completionTiming(task)}`:""}${deadline.outcome(task.due,task.doneDate||task.date)?` · Deadline ${deadline.outcome(task.due,task.doneDate||task.date).toLowerCase()}`:""}`:task.date&&task.date<today()?`Carried from ${dateLabel(task.date)}`:dateLabel(task.date)}</span>{dueOf&&<span className={`due ${dueOf.level}`} title={dueOf.title}>{dueOf.label}</span>}</div>
        {attached&&<a className="task-open-link" href={attached.href} target="_blank" rel="noreferrer noopener" aria-label={`Open link for ${task.text}: ${attached.hostname}`}><ExternalLink size={16} aria-hidden="true"/><span>Open link <span className="link-host">{attached.hostname}</span></span></a>}</div>
        <ChevronRight size={17} className="row-arrow" aria-hidden="true"/>
      </li>;
    })}</ul>
    {view.ready&&!visible.length&&<section className="empty"><div className="empty-check"><Check size={26}/></div><h2>{search?"No matching tasks":tab==="done"?"Progress starts small.":"Room to focus."}</h2><p>{search?"Try another word or clear your search.":tab==="today"?"Add one thing worth your attention. The rest can wait.":"Your tasks will appear here when you add or complete them."}</p></section>}
    <footer><span>Nice Try &middot; Phone companion</span>{!installed&&<button className="quiet" onClick={()=>{if(install)void act(async()=>{await install.prompt();const choice=await install.userChoice;if(choice.outcome==="accepted"){localStorage.setItem("nice-try.installed","1");setInstalled(true);}setInstall(null);});else setError("Open your browser menu and choose Install app or Add to Home screen.");}}><Smartphone size={16}/>Add to phone</button>}</footer>
    <dialog ref={dialog} onCancel={()=>setEdit(null)} onClick={e=>{if(e.target===e.currentTarget)setEdit(null);}}><form onSubmit={e=>{e.preventDefault();if(!edit||(!editText.trim()&&!editLink.trim()))return;void act(async()=>{const parsed=parseLink(editLink);await service.save(edit.base,edit.base.map(t=>t.id===edit.task.id?withDue(withLink({...t,text:editText.trim()||(parsed?parsed.host:""),date:editDate},editLink),editDueDay,editDueTime):t),edit.owner);setEdit(null);});}}>
      <div className="dialog-head"><h2>Edit task</h2><button type="button" className="icon-button" aria-label="Close task" onClick={()=>setEdit(null)}><X size={22}/></button></div><label htmlFor="editText">Task</label><textarea id="editText" value={editText} onChange={e=>setEditText(e.target.value)} maxLength={4000}/><label htmlFor="editDate">Planned for</label><input type="date" id="editDate" value={editDate} onChange={e=>setEditDate(e.target.value)} required/>
      <label htmlFor="editDueDay">Deadline <span className="optional">(optional)</span></label><div className="due-fields"><input id="editDueDay" type="date" value={editDueDay} onChange={e=>setEditDueDay(e.target.value)}/><input aria-label="Deadline time (optional)" type="time" value={editDueTime} onChange={e=>setEditDueTime(e.target.value)}/>{(editDueDay||editDueTime)&&<button type="button" className="quiet" onClick={()=>{setEditDueDay("");setEditDueTime("");}}>Clear</button>}</div>
      <label htmlFor="editLink">Link</label><input id="editLink" type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={editLink} onChange={e=>setEditLink(e.target.value)} placeholder="Paste a link (optional)" maxLength={2000}/>
      {(()=>{const p=parseLink(editLink);return p?<a className="task-link" href={p.url} target="_blank" rel="noreferrer noopener">Open {p.host} ↗</a>:null;})()}{error&&<p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="danger" disabled={saving} onClick={()=>{if(edit&&window.confirm("Delete this task?"))void act(async()=>{await service.save(edit.base,edit.base.filter(t=>t.id!==edit.task.id),edit.owner);setEdit(null);});}}>Delete task</button><button type="submit" disabled={saving||(!editText.trim()&&!editLink.trim())}>Save changes</button></div></form></dialog>
  </main>;
}
