import { Database, LockKeyhole, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

const CONTACT_EMAIL = 'postmaster@micutu.com';

export default function PrivacyPage() {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-[hsl(var(--border))] pb-6">
        <div className="flex items-center gap-2 text-[hsl(var(--primary))]">
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-semibold">Văzute</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold sm:text-3xl">Privacy policy</h1>
        <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
          Effective and last updated: July 17, 2026
        </p>
      </header>

      <div className="divide-y divide-[hsl(var(--border))]">
        <PolicySection title="Who is responsible" icon={<ShieldCheck className="h-5 w-5" />}>
          <p>
            Văzute is operated by Dragne Alexandru Mihai. Questions and privacy requests can be
            sent to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </PolicySection>

        <PolicySection title="Data we process" icon={<Database className="h-5 w-5" />}>
          <ul>
            <li>Account data: email address, username, password hash, profile text, avatar, and privacy settings.</li>
            <li>Viewing data: library statuses, favorites, ratings, reviews, lists, planned episodes, watch history, and dates.</li>
            <li>Social data: follows, follow requests, notifications, and activity visible under the selected privacy setting.</li>
            <li>Preferences and imports: region, language, and TV Time import records supplied by the user.</li>
            <li>Security data: session token hashes, IP address, user agent, request timestamps, and security/audit logs.</li>
            <li>Mobile diagnostics: sanitized error name, message and stack, app version, platform, time, and whether the failure was fatal. Tokens, email addresses, URL parameters, device identifiers, and advertising identifiers are not included.</li>
            <li>Release alerts, when enabled: an Expo push token, platform, app version, time-zone offset, enablement time, and a short-lived delivery record containing the relevant title and release.</li>
          </ul>
        </PolicySection>

        <PolicySection title="How data is used" icon={<LockKeyhole className="h-5 w-5" />}>
          <p>
            Data is used to authenticate accounts, synchronize the library across devices, build
            calendars and statistics, provide social features, deliver password-reset messages,
            send release alerts requested by the user, prevent abuse, diagnose failures, and protect the service. For users in the EEA, these
            activities rely on performance of the service contract and legitimate interests in
            security and reliability. Văzute does not sell personal data and does not include
            advertising or third-party analytics SDKs.
          </p>
        </PolicySection>

        <PolicySection title="Service providers" icon={<Database className="h-5 w-5" />}>
          <ul>
            <li>Cloudflare R2 stores profile avatars, cached public media assets, catalog exports, and encrypted-at-rest infrastructure backups.</li>
            <li>TMDB supplies movie and television metadata. Search terms, media identifiers, language, and region may be sent from the Văzute server without the user's email or Văzute account identifier.</li>
            <li>Resend processes the recipient address and transactional message content for email delivery; the recipient's email provider also processes that delivery.</li>
            <li>For users who enable release alerts, Expo relays the push token and notification content to Google Firebase Cloud Messaging or Apple Push Notification service. No advertising identifier or Văzute account identifier is included in the notification payload.</li>
            <li>Apple, Google, and Expo may separately process app distribution or build information under their own policies; no advertising identifier is sent to Văzute.</li>
          </ul>
          <p>
            Personal data may also be disclosed when required by law or necessary to protect users
            and the service. It is not shared for behavioral advertising.
          </p>
        </PolicySection>

        <PolicySection title="Retention and deletion" icon={<Trash2 className="h-5 w-5" />}>
          <p>
            Account and viewing data is retained while the account exists. A confirmed account
            deletion removes the live account, sessions, profile avatar, library, history, lists,
            reviews, social relationships, and notifications. Daily disaster-recovery backups are
            retained for at most 14 days, so deleted records may remain inaccessible in a backup
            until that backup expires. Web access logs are rotated daily and retained for up to 14
            days. Mobile diagnostic reports stay only in size-limited rotating server logs and are
            not stored in the application database. Shared media metadata that is not linked to an
            account may remain cached. Disabling release alerts removes the registered device from
            Văzute; completed or permanently failed delivery records are removed after 30 days.
          </p>
          <p>
            Use the <Link to="/account-deletion">account deletion page</Link> for the available
            in-app and web deletion methods.
          </p>
        </PolicySection>

        <PolicySection title="Your choices and rights" icon={<Mail className="h-5 w-5" />}>
          <p>
            Account settings allow users to correct profile information, control profile visibility,
            manage sessions, disable release alerts, and delete the account. System notification
            settings provide an additional platform-level control. Depending on local law, users may also request
            access, correction, restriction, portability, objection, or deletion by contacting the
            address above. EEA users may lodge a complaint with their local data-protection authority.
          </p>
        </PolicySection>

        <PolicySection title="Security, children, and changes" icon={<LockKeyhole className="h-5 w-5" />}>
          <p>
            Văzute uses HTTPS, hashed passwords and tokens, restricted database roles, request
            validation, rate limits, and encrypted-at-rest infrastructure. No internet service can
            guarantee absolute security. Văzute is not directed to children under 13 and does not
            knowingly collect their personal data. Material policy changes will be reflected on this
            page with a new effective date.
          </p>
        </PolicySection>
      </div>
    </article>
  );
}

function PolicySection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="py-7">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-[hsl(var(--foreground))]">
        <span className="text-[hsl(var(--primary))]" aria-hidden="true">{icon}</span>
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-[hsl(var(--muted-foreground))] [&_a]:font-medium [&_a]:text-[hsl(var(--primary))] [&_a]:underline-offset-4 hover:[&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1">
        {children}
      </div>
    </section>
  );
}
