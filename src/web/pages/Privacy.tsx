/** The privacy notice shown to students. DRAFT: it describes what this software actually does; it is not legal advice and the operator must review it (see docs/PILOT.md). */
export function Privacy({ session }: { session: any }) {
  const op = session?.operator ?? { name: '', contact: '' };
  return (
    <div className="narrow">
      <p className="small muted"><a href="#/">← Back</a></p>
      <h1>Privacy notice</h1>
      <div className="notice warn small" role="note"><strong>Draft for the pilot.</strong> This describes what the software does today. The person running the pilot must confirm the details below before students use it.</div>
      <h2>Who runs this</h2>
      <p>{op.name ? <><strong>{op.name}</strong>, contact <strong>{op.contact}</strong>.</> : <strong>Not configured yet: ask the person who invited you.</strong>} Study Helper is a small invite-only pilot run by an individual student, not by a school or a company. Your school did not approve it unless they told you so.</p>
      <h2>What we keep</h2>
      <ul>
        <li><strong>Your email address</strong> (to sign you in). No name or profile photo is stored from Google.</li>
        <li><strong>What you add and do:</strong> materials you paste or upload (and the original files), highlights and notes, your answers, <strong>homework</strong> (the assignment sheet, every version of your working, the help you asked for and each check), grades, saved memory notes, chat conversations and the assignments you enter. These are stored privately for your account only. Other students cannot see them, and the pilot has no screen that shows anyone’s answers or conversations.</li>
        <li><strong>Google Calendar, only if you connect it:</strong> read-only. The access token is stored encrypted and is unique to your account. You can disconnect and delete imported events at any time.</li>
        <li><strong>Operations data without your content:</strong> counts and timings of requests, error counts, and the estimated cost of study-assistant requests. Problem reports you choose to send (you see exactly what is sent first).</li>
      </ul>
      <h2>The study assistant (outside processing)</h2>
      <p>When you use features that need the study assistant (making questions, grading written answers, explanations, feedback, chat, homework hints and checks), the text needed for that task (for example part of your reading, your answer, and a few relevant saved notes in Study mode) is sent to the AI provider the operator configured, <strong>Anthropic</strong> by default, over an encrypted connection. Your name and email are not sent. Chat in <em>General</em> mode sends none of your study materials. Reading scans with a vision model is off unless the operator turns it on, and you approve each time. The assistant can be wrong; labelled explanations and checks are fallible.</p>
      <p>The provider’s own terms and retention apply to what it receives. The operator should confirm the provider’s data-retention setting; see the operator notes in the project documentation.</p>
      <h2>What we do not do</h2>
      <ul><li>No advertising, no selling or sharing your data, no public profiles, no showing your work to other students.</li><li>Your content is not used by the operator to train any model.</li></ul>
      <h2>How long, and your controls</h2>
      <ul>
        <li>Your study data stays until you delete it or your account. <strong>Settings → Account</strong> lets you <strong>download everything</strong> and <strong>delete your account</strong>: your files and records are removed immediately; backups made earlier are deleted when they expire (the operator keeps backups for a limited time, see the project documentation).</li>
        <li>Event logs (without content) are kept up to {session?.retentionDays?.audit ?? 180} days; problem reports up to {session?.retentionDays?.reports ?? 90} days after they are resolved.</li>
        <li>The operator can pause the whole site, stop new sign-ups, or switch the assistant off at any time.</li>
      </ul>
      <h2>Age and permission</h2>
      <p>This pilot is meant for students of an age the operator has confirmed is allowed, with any permission the school or a parent requires. If you are not sure you are allowed to use it, ask before you sign up. <em>The operator has not yet confirmed these requirements; see “Open items” in the project’s pilot documentation.</em></p>
    </div>
  );
}
