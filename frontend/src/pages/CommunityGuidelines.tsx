import { LegalDocument } from '@/components/LegalDocument';
import { useT } from '@/hooks/useT';
import { usePageMeta } from '@/hooks/usePageMeta';

export default function CommunityGuidelinesPage() {
  const t = useT();
  usePageMeta({ title: t('legal.guidelinesTitle'), path: '/community-guidelines' });

  return (
    <LegalDocument
      title={t('legal.guidelinesTitle')}
      effective={t('legal.effective')}
      intro={t('legal.guidelinesIntro')}
      contactLead={t('legal.contactTitle')}
      sections={[
        { title: t('legal.guidelines1Title'), body: t('legal.guidelines1Body') },
        { title: t('legal.guidelines2Title'), body: t('legal.guidelines2Body') },
        { title: t('legal.guidelines3Title'), body: t('legal.guidelines3Body') },
        { title: t('legal.guidelines4Title'), body: t('legal.guidelines4Body') },
        { title: t('legal.guidelines5Title'), body: t('legal.guidelines5Body') },
        { title: t('legal.guidelines6Title'), body: t('legal.guidelines6Body') },
        { title: t('legal.guidelines7Title'), body: t('legal.guidelines7Body') },
        { title: t('legal.guidelines8Title'), body: t('legal.guidelines8Body') },
      ]}
    />
  );
}
