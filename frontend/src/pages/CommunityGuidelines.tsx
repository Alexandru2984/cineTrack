import { LegalDocument } from '@/components/LegalDocument';
import { useT } from '@/hooks/useT';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function CommunityGuidelinesPage() {
  const t = useT();
  usePageTitle(t('legal.guidelinesTitle'));

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
