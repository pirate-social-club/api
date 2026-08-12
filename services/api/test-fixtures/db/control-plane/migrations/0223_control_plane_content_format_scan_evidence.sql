-- Append-only format-validation evidence for the same verified bytes as each
-- malware scan attempt. Existing rows predate format validation and remain
-- explicitly nullable; new text-profile writers provide the complete tuple.

-- migration-safety: existing-table-check-reviewed: all pre-migration rows receive five NULL columns and satisfy the explicit legacy tuple arm
ALTER TABLE content_security_scan_results
    ADD COLUMN content_format_policy_version TEXT,
    ADD COLUMN content_format_outcome TEXT,
    ADD COLUMN detected_mime_type TEXT,
    ADD COLUMN content_format_finding_code TEXT,
    ADD COLUMN content_format_error_code TEXT,
    ADD CONSTRAINT content_security_scan_results_format_evidence_check CHECK (
        (
            content_format_policy_version IS NULL
            AND content_format_outcome IS NULL
            AND detected_mime_type IS NULL
            AND content_format_finding_code IS NULL
            AND content_format_error_code IS NULL
        )
        OR (
            content_format_policy_version IS NOT NULL
            AND length(trim(content_format_policy_version)) > 0
            AND content_format_outcome IN ('allow', 'reject', 'error')
            AND (
                (
                    content_format_outcome = 'allow'
                    AND detected_mime_type IS NOT NULL
                    AND length(trim(detected_mime_type)) > 0
                    AND content_format_finding_code IS NULL
                    AND content_format_error_code IS NULL
                )
                OR (
                    content_format_outcome = 'reject'
                    AND content_format_finding_code IS NOT NULL
                    AND length(trim(content_format_finding_code)) > 0
                    AND content_format_error_code IS NULL
                )
                OR (
                    content_format_outcome = 'error'
                    AND content_format_finding_code IS NULL
                    AND content_format_error_code IS NOT NULL
                    AND length(trim(content_format_error_code)) > 0
                )
            )
        )
    );
