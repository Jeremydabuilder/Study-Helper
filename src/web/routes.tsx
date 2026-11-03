import { Today } from './pages/Today';
import { Study } from './pages/Study';
import { Subjects, SubjectDetail } from './pages/Subjects';
import { StartFlow } from './pages/StartFlow';
import { Prepare } from './pages/Prepare';
import { ReviewSource } from './pages/ReviewSource';
import { Plan } from './pages/Plan';
import { CalendarPage } from './pages/CalendarPage';
import { Progress } from './pages/Progress';
import { Memory } from './pages/Memory';
import { Settings } from './pages/Settings';
import { Readings, Outline } from './pages/Readings';
import { Reader } from './pages/Reader';
import { Chat } from './pages/Chat';
import { HomeworkDetail, HomeworkFrom, HomeworkList, NewHomework, WorkPhoto } from './pages/Homework';

export interface RouteExtras { meta: any; hosted: any; onSignOut?: () => void }
/** The page for an application path. Shared by the ordinary app shell and by the owner's My Helper shell, so both open exactly the same Study Helper pages. */
export function pageFor(path: string, route: string, go: (p: string) => void, { meta, hosted, onSignOut }: RouteExtras) {
  let page;
  if (path.startsWith('/study/')) page = <Study id={path.split('/')[2]} go={go} />;
  else if (path.startsWith('/read/')) page = <Reader id={path.split('/')[2]} go={go} />;
  else if (path === '/readings') page = <Readings go={go} />;
  else if (path.startsWith('/outline/')) page = <Outline id={path.split('/')[2]} go={go} />;
  else if (path === '/homework') page = <HomeworkList go={go} />;
  else if (path === '/homework/new') page = <NewHomework go={go} />;
  else if (path.startsWith('/homework/from/')) page = <HomeworkFrom sourceId={path.split('/')[3]} go={go} />;
  else if (path.startsWith('/homework/photo/')) page = <WorkPhoto hwId={path.split('/')[3]} qid={path.split('/')[4]} go={go} />;
  else if (path.startsWith('/homework/')) page = <HomeworkDetail id={path.split('/')[2]} go={go} />;
  else if (path === '/chat') page = <Chat go={go} />;
  else if (path === '/start') page = <StartFlow go={go} />;
  else if (path.startsWith('/prepare/')) page = <Prepare sourceId={path.split('/')[2]} go={go} />;
  else if (path === '/review') page = <Today go={go} meta={meta} />;
  else if (path.startsWith('/review/')) page = <ReviewSource id={path.split('/')[2]} go={go} />;
  else if (path.startsWith('/subjects/')) page = <SubjectDetail id={path.split('/')[2]} go={go} />;
  else if (path === '/subjects') page = <Subjects go={go} />;
  else if (path === '/plan') page = <Plan go={go} />;
  else if (path === '/calendar') page = <CalendarPage guest={!!hosted?.guest} go={go} query={route.split('?')[1] ?? ''} />;
  else if (path === '/progress') page = <Progress go={go} />;
  else if (path === '/memory') page = <Memory go={go} />;
  else if (path === '/settings') page = <Settings go={go} meta={meta.data} hosted={hosted} onSignOut={onSignOut} />;
  else page = <Today go={go} meta={meta.data} />;
  return page;
}
