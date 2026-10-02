"use client";
import { useEffect, useRef, useState } from "react";
import { Plus, Check, ChevronRight, X, CalendarDays, RefreshCw, Smartphone, Download, Upload } from "lucide-react";
import * as service from "../lib/task-service";
import type { Task, View } from "../lib/task-service";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const dateLabel = (date?: string) => !date || date === today() ? "Today" : new Date(date + "T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"});
function download(text:string) {
  const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));
  const a=document.createElement("a"); a.href=url; a.download=`nice-try-tasks-${today()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function Home() {
  const [view,setView]=useState<View>({tasks:[],email:"",status:"Opening your tasks…",ready:false,busy:false,owner:"guest"});
  const [tab,setTab]=useState("today"),[search,setSearch]=useState(""),[text,setText]=useState(""),[date,setDate]=useState("");
  const [account,setAccount]=useState(false),[importLocal,setImportLocal]=useState(false),[error,setError]=useState(""),[saving,setSaving]=useState(false);
  const [edit,setEdit]=useState<{task:Task;base:Task[];owner:string}|null>(null),[editText,setEditText]=useState(""),[editDate,setEditDate]=useState("");
  const [installed,setInstalled]=useState(false);
  const [install,setInstall]=useState<{prompt():Promise<void>;userChoice:Promise<{outcome:string}>}|null>(null);
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
    .sort((a,b)=>Number(a.done)-Number(b.done)||(tab==="upcoming"?(a.date||"").localeCompare(b.date||""):0)||(a.rank||0)-(b.rank||0));
  async function toggle(task:Task){const next={...task,done:!task.done};if(next.done)next.doneDate=today();else delete next.doneDate;await service.save(view.tasks,view.tasks.map(t=>t.id===task.id?next:t),view.owner);}
  if(account) return <main className="app account-screen">
<nav className="account-nav"><button className="quiet" onClick={()=>setAccount(false)}>&lsaquo; Tasks</button><span>Nice Try</span></nav>
<section className="profile-hero"><div className="profile-avatar">{view.email?view.email.charAt(0).toUpperCase():<img src="/logo-mark.png" alt="" width="48" height="48"/>}</div><p className="eyebrow">YOUR ACCOUNT</p><h1>{view.email?"You're connected.":"Your focus, everywhere."}</h1><p className="profile-email">{view.email||"One task list. Phone and browser."}</p>{view.email&&<span className="account-pill"><span className="dot connected"/>Google account connected</span>}</section>
{error&&<p className="error" role="alert">{error}</p>}
{view.email?<><section className="account-panel sync-panel"><div className="section-icon"><RefreshCw size={21} className={view.busy?"spin":""}/></div><div className="sync-copy"><h2>Task sync</h2><p role="status">{view.status}</p></div><button className="quiet" disabled={saving||view.busy} onClick={()=>act(service.sync)}>{view.busy?"Syncing...":"Sync now"}</button></section><button className="continue-tasks" onClick={()=>setAccount(false)}>Back to your tasks<ChevronRight size={18}/></button></>:<section className="account-panel"><label className="check-label"><input type="checkbox" checked={importLocal} onChange={e=>setImportLocal(e.target.checked)}/>Include tasks saved on this phone</label><button className="continue-tasks" disabled={!service.configured||saving||!view.ready} onClick={()=>act(()=>service.connect(importLocal))}>{saving?"Connecting...":"Continue with Google"}</button>{!service.configured&&<p>Sign-in is temporarily unavailable.</p>}</section>}
<details className="account-panel backup-panel"><summary>Backup & account</summary><div className="backup-actions"><button className="quiet" disabled={!view.ready} onClick={()=>download(service.exportTasks())}><Download size={17}/>Export tasks</button><button className="quiet" disabled={!view.ready||saving} onClick={()=>importInput.current?.click()}><Upload size={17}/>Import tasks</button>{view.email&&<button className="quiet danger" disabled={saving} onClick={()=>act(service.disconnect)}>Sign out</button>}</div><p className="fine">Only tasks sync. Your browsing history stays on your device.</p></details>
<input ref={importInput} type="file" accept="application/json,.json" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value="";if(file)void act(async()=>{if(file.size>5_000_000)throw Error("Choose a task export smaller than 5 MB.");await service.importTasks(await file.text());});}}/>
</main>;
  return <main className="app">
    <header className="topbar"><a className="brand" href="/"><img className="brand-logo" src="/logo-mark.png" alt="" width="40" height="40"/><span>Nice Try<span className="brand-sub">DAILY FOCUS</span></span></a><button className="account-button" aria-expanded={account} onClick={()=>setAccount(!account)}>{view.email?view.email.split("@")[0]:"Sign in"}<ChevronRight size={16}/></button></header>

    <section className="heading"><div><p className="eyebrow">YOUR DAILY FOCUS</p><h1>{tab==="upcoming"?"Upcoming":tab==="done"?"Completed":tab==="all"?"All tasks":"Today's focus"}</h1><p className="intro">{due.length?`${due.length} ${due.length===1?"task needs":"tasks need"} your attention today.`:"A clear day starts with a small intention."}</p></div><div className="tally"><strong>{String(done.length).padStart(2,"0")}</strong><span>completed</span></div></section>
    <div className="connection"><span className={view.email?"dot connected":"dot"}/><span role="status">{view.status}</span>{view.email&&<button className="icon-button" aria-label="Sync tasks now" disabled={saving||view.busy} onClick={()=>act(service.sync)}><RefreshCw size={16} className={view.busy?"spin":""}/></button>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    <form className="composer" onSubmit={e=>{e.preventDefault();if(!text.trim())return;void act(async()=>{const next:Task={id:crypto.randomUUID(),text:text.trim(),done:false,date:date||today(),rank:Math.max(0,...view.tasks.map(t=>t.rank||0))+1024};await service.save(view.tasks,[...view.tasks,next],view.owner);setText("");});}}>
      <label className="sr-only" htmlFor="taskText">New task</label><input id="taskText" value={text} onChange={e=>setText(e.target.value)} placeholder="What will you work on?" maxLength={4000} required disabled={!view.ready||saving}/><div className="composer-actions"><label className="date-input"><CalendarDays size={17}/><input aria-label="Task date" type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label><button className="add" type="submit" disabled={!view.ready||saving||!text.trim()}><Plus size={20}/><span>Add task</span></button></div></form>
    <nav className="tabs" aria-label="Task views">{[["today","Today",due.length],["upcoming","Upcoming",open.length-due.length],["all","All tasks",view.tasks.length],["done","Done",done.length]].map(([key,name,count])=><button key={key} className={tab===key?"selected":""} aria-pressed={tab===key} onClick={()=>setTab(String(key))}>{name}<span>{count}</span></button>)}</nav>
    <div className="list-top"><h2>{search?"Search results":tab==="today"?"Your focus":tab==="upcoming"?"Coming up":tab==="done"?"Finished":"Everything"}</h2><input type="search" aria-label="Search all tasks" placeholder="Find a task" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    <ul className="task-list">{visible.map((task,i)=><li className={task.done?"task done":"task"} key={task.id}><button className="tick" aria-label={`${task.done?"Reopen":"Complete"}: ${task.text}`} aria-pressed={task.done} disabled={saving||!view.ready} onClick={()=>act(()=>toggle(task))}>{task.done&&<Check size={18}/>}</button><button className="task-main" disabled={!view.ready} onClick={()=>{setEdit({task,base:structuredClone(view.tasks),owner:view.owner});setEditText(task.text);setEditDate(task.date||today());}}><span className="task-text">{task.text}</span><span className="task-meta">{task.done?`Completed ${dateLabel(task.doneDate||task.date)}`:task.date&&task.date<today()?`Carried from ${dateLabel(task.date)}`:dateLabel(task.date)}{task.url?" · Has a link":""}</span></button><span className="task-number">{String(i+1).padStart(2,"0")}</span><ChevronRight size={17} className="row-arrow"/></li>)}</ul>
    {view.ready&&!visible.length&&<section className="empty"><div className="empty-check"><Check size={26}/></div><h2>{search?"No matching tasks":tab==="done"?"Progress starts small.":"Room to focus."}</h2><p>{search?"Try another word or clear your search.":tab==="today"?"Add one thing worth your attention. The rest can wait.":"Your tasks will appear here when you add or complete them."}</p></section>}
    <footer><span>Nice Try &middot; Phone companion</span>{!installed&&<button className="quiet" onClick={()=>{if(install)void act(async()=>{await install.prompt();const choice=await install.userChoice;if(choice.outcome==="accepted"){localStorage.setItem("nice-try.installed","1");setInstalled(true);}setInstall(null);});else setError("Open your browser menu and choose Install app or Add to Home screen.");}}><Smartphone size={16}/>Add to phone</button>}</footer>
    <dialog ref={dialog} onCancel={()=>setEdit(null)} onClick={e=>{if(e.target===e.currentTarget)setEdit(null);}}><form onSubmit={e=>{e.preventDefault();if(!edit||!editText.trim())return;void act(async()=>{await service.save(edit.base,edit.base.map(t=>t.id===edit.task.id?{...t,text:editText.trim(),date:editDate}:t),edit.owner);setEdit(null);});}}>
      <div className="dialog-head"><h2>Edit task</h2><button type="button" className="icon-button" aria-label="Close task" onClick={()=>setEdit(null)}><X size={22}/></button></div><label htmlFor="editText">Task</label><textarea id="editText" value={editText} onChange={e=>setEditText(e.target.value)} maxLength={4000} required/><label htmlFor="editDate">Planned for</label><input type="date" id="editDate" value={editDate} onChange={e=>setEditDate(e.target.value)} required/>
      {edit?.task.url&&/^https?:\/\//i.test(edit.task.url)&&<a className="task-link" href={edit.task.url} target="_blank" rel="noreferrer noopener">Open attached link ↗</a>}{error&&<p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="danger" disabled={saving} onClick={()=>{if(edit&&window.confirm("Delete this task?"))void act(async()=>{await service.save(edit.base,edit.base.filter(t=>t.id!==edit.task.id),edit.owner);setEdit(null);});}}>Delete task</button><button type="submit" disabled={saving||!editText.trim()}>Save changes</button></div></form></dialog>
  </main>;
}
