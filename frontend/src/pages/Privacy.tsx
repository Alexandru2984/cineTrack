import { Database, LockKeyhole, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { useT } from '@/hooks/useT';

const CONTACT_EMAIL = 'postmaster@micutu.com';

export default function PrivacyPage() {
  const t = useT();
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-[hsl(var(--border))] pb-6">
        <div className="flex items-center gap-2 text-[hsl(var(--primary))]">
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-semibold">Văzute</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold sm:text-3xl">{t('privacy.title')}</h1>
        <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
          {t('privacy.effective')}
        </p>
      </header>

      <div className="divide-y divide-[hsl(var(--border))]">
        <PolicySection title={t('privacy.s1Title')} icon={<ShieldCheck className="h-5 w-5" />}>
          <p>
            {t('privacy.s1Pre')} <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </PolicySection>

        <PolicySection title={t('privacy.s2Title')} icon={<Database className="h-5 w-5" />}>
          <ul>
            <li>{t('privacy.data1')}</li>
            <li>{t('privacy.data2')}</li>
            <li>{t('privacy.data3')}</li>
            <li>{t('privacy.data4')}</li>
            <li>{t('privacy.data5')}</li>
            <li>{t('privacy.data6')}</li>
            <li>{t('privacy.data7')}</li>
            <li>{t('privacy.data8')}</li>
            <li>{t('privacy.data9')}</li>
          </ul>
        </PolicySection>

        <PolicySection title={t('privacy.s3Title')} icon={<LockKeyhole className="h-5 w-5" />}>
          <p>{t('privacy.use1')}</p>
          <p>{t('privacy.use2')}</p>
        </PolicySection>

        <PolicySection title={t('privacy.s4Title')} icon={<Database className="h-5 w-5" />}>
          <ul>
            <li>{t('privacy.provider1')}</li>
            <li>{t('privacy.provider2')}</li>
            <li>{t('privacy.provider3')}</li>
            <li>{t('privacy.provider4')}</li>
            <li>{t('privacy.provider5')}</li>
            <li>{t('privacy.provider6')}</li>
            <li>{t('privacy.provider7')}</li>
          </ul>
          <p>{t('privacy.providerNote')}</p>
          <p>{t('privacy.transfers')}</p>
        </PolicySection>

        <PolicySection title={t('privacy.s8Title')} icon={<Database className="h-5 w-5" />}>
          <p>{t('privacy.cookies')}</p>
        </PolicySection>

        <PolicySection title={t('privacy.s5Title')} icon={<Trash2 className="h-5 w-5" />}>
          <p>{t('privacy.retention1')}</p>
          <p>
            {t('privacy.retention2Pre')} <Link to="/account-deletion">{t('privacy.retention2Link')}</Link>{' '}
            {t('privacy.retention2Post')}
          </p>
        </PolicySection>

        <PolicySection title={t('privacy.s6Title')} icon={<Mail className="h-5 w-5" />}>
          <p>{t('privacy.rights')}</p>
        </PolicySection>

        <PolicySection title={t('privacy.s7Title')} icon={<LockKeyhole className="h-5 w-5" />}>
          <p>{t('privacy.security')}</p>
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
      <div className="mt-3 space-y-3 text-sm leading-6 text-[hsl(var(--muted-foreground))] [&_a]:font-medium [&_a]:text-[hsl(var(--primary))] [&_a]:underline [&_a]:underline-offset-4 [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1">
        {children}
      </div>
    </section>
  );
}
