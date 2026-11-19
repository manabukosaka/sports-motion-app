$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) {
        throw $Message
    }
}

function Read-JsonObject {
    param([string]$Path)

    $json = Get-Content -LiteralPath $Path -Encoding UTF8 -Raw
    $strictJsonTokens = @'
(?x)\A(?>
    [\x20\t\r\n]+
    | "(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"
    | [{}\[\]:]
    | ,(?![\x20\t\r\n]*[}\]])
    | (?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)
        (?=[\x20\t\r\n]*(?:[,}\]]|\z))
)+\z
'@
    Assert-True ($json -cmatch $strictJsonTokens) "Invalid JSON tokens in $Path."
    $parameters = @{ InputObject = $json }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
        $parameters.DateKind = 'String'
    }
    $value = ConvertFrom-Json @parameters
    Assert-True ($json.TrimStart().StartsWith('{') -and $value -is [pscustomobject]) "Expected a JSON object in $Path."
    return $value
}

function Assert-ObjectShape {
    param($Value, $Definition, [string]$Location)

    Assert-True ($Value -is [pscustomobject]) "Expected an object at $Location."
    $names = $Value.PSObject.Properties.Name
    foreach ($name in $Definition.required) {
        Assert-True ($names -ccontains $name) "Missing property $Location.$name."
    }
    foreach ($name in $names) {
        Assert-True ($Definition.properties.PSObject.Properties.Name -ccontains $name) "Unknown property $Location.$name."
    }
}

function Assert-Text {
    param($Value, [string]$Location)

    Assert-True ($Value -is [string] -and $Value -cmatch '\S') "Expected non-empty text at $Location."
}

function Test-Integer {
    param($Value)

    return $Value -is [int] -or $Value -is [long]
}

try {
    $evidenceDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs/evidence'
    $schema = Read-JsonObject (Join-Path $evidenceDir 'evidence-record.schema.json')
    $catalog = Read-JsonObject (Join-Path $evidenceDir 'initial-literature-catalog.json')
    Assert-True ($schema.'$schema' -ceq 'https://json-schema.org/draft/2020-12/schema') 'Expected a Draft 2020-12 schema.'

    $definitions = $schema.'$defs'
    $studySchema = $definitions.study
    $metricSchema = $definitions.normative_metric
    $canonicalMetrics = $definitions.metric_id.enum
    Assert-True ($canonicalMetrics -is [array] -and $canonicalMetrics.Count -gt 0) 'Missing canonical metric IDs in the schema.'

    Assert-ObjectShape $catalog $schema 'registry'
    Assert-Text $catalog.evidence_registry_version 'registry.evidence_registry_version'
    Assert-True ($catalog.evidence_registry_version -cmatch $schema.properties.evidence_registry_version.pattern) 'Invalid Evidence Registry SemVer.'
    $generatedAt = [DateTimeOffset]::MinValue
    Assert-True ($catalog.generated_at -is [string] -and
        $catalog.generated_at -cmatch '^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})\z' -and
        [DateTimeOffset]::TryParse($catalog.generated_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$generatedAt)) 'Invalid generated_at timestamp.'
    Assert-ObjectShape $catalog.disclaimer_policy $schema.properties.disclaimer_policy 'disclaimer_policy'
    Assert-Text $catalog.disclaimer_policy.user_facing_text_ja 'disclaimer_policy.user_facing_text_ja'
    Assert-True ($catalog.disclaimer_policy.non_diagnostic_flag -is [bool] -and $catalog.disclaimer_policy.non_diagnostic_flag -and
        $catalog.disclaimer_policy.show_on_comparison_and_share -is [bool] -and $catalog.disclaimer_policy.show_on_comparison_and_share) 'Invalid non-diagnostic disclaimer policy.'
    Assert-True ($catalog.studies -is [array] -and $catalog.studies.Count -eq 26) 'Expected exactly 26 studies in the initial catalog.'
    Assert-True ($catalog.normative_metrics -is [array]) 'Expected a normative_metrics array.'

    $mvpDomains = @('baseball_pitching', 'running', 'jump_landing')
    $domainCounts = @{ baseball_pitching = 0; running = 0; jump_landing = 0; standard_method = 0 }
    $metricPatternByDomain = @{}
    foreach ($rule in $studySchema.allOf) {
        $metricPatternByDomain[$rule.if.properties.domain.const] = $rule.then.properties.metrics_covered.items.pattern
    }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $studiesByDoi = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($study in $catalog.studies) {
        Assert-ObjectShape $study $studySchema 'study'
        Assert-Text $study.id 'study.id'
        $id = $study.id
        Assert-True ($id -cmatch $studySchema.properties.id.pattern -and $id -ceq $id.Trim()) "Invalid study ID: $id."
        Assert-True ($ids.Add($id)) "Duplicate study ID: $id."
        Assert-True ($study.domain -is [string] -and $studySchema.properties.domain.enum -ccontains $study.domain) "$id has an invalid domain."
        $domainCounts[$study.domain]++
        foreach ($field in @('journal', 'title', 'population_notes', 'comparability_bias_note', 'doi')) {
            Assert-Text $study.$field "$id.$field"
        }
        Assert-True ($study.authors -is [array] -and $study.authors.Count -gt 0) "$id must have at least one author."
        foreach ($author in $study.authors) {
            Assert-Text $author "$id.authors"
        }
        Assert-True ((Test-Integer $study.year) -and $study.year -ge 1980 -and $study.year -le 2026) "$id has a year outside 1980..2026."
        Assert-True ($study.doi -cmatch $definitions.doi.pattern -and $study.doi -ceq $study.doi.Trim()) "$id has an invalid DOI: $($study.doi)."
        Assert-True (-not $studiesByDoi.ContainsKey($study.doi)) "Duplicate DOI: $($study.doi)."
        $studiesByDoi.Add($study.doi, $study)
        foreach ($field in @('measurement_modality', 'extraction_status')) {
            Assert-True ($study.$field -is [string] -and $studySchema.properties.$field.enum -ccontains $study.$field) "$id has an invalid $field."
        }
        Assert-True ($study.metrics_covered -is [array]) "$id.metrics_covered must be an array."
        $seenMetrics = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($metricId in $study.metrics_covered) {
            Assert-True ($metricId -is [string] -and $canonicalMetrics -ccontains $metricId) "$id has an unknown metric ID: $metricId."
            Assert-True ($seenMetrics.Add($metricId)) "$id repeats metric ID: $metricId."
            if ($mvpDomains -ccontains $study.domain) {
                Assert-True ($metricId -cmatch $metricPatternByDomain[$study.domain]) "$id maps to a metric outside its domain: $metricId."
            }
        }
    }

    foreach ($domain in $mvpDomains) {
        Assert-True ($domainCounts[$domain] -ge 5) "Expected at least five studies for $domain."
    }

    $verifiedStudyDois = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($metric in $catalog.normative_metrics) {
        Assert-ObjectShape $metric $metricSchema 'normative_metric'
        Assert-True ($metric.metric_id -is [string] -and $canonicalMetrics -ccontains $metric.metric_id) "Unknown normative metric ID: $($metric.metric_id)."
        Assert-True ($metric.source_doi -is [string] -and $studiesByDoi.ContainsKey($metric.source_doi)) "Uncataloged source DOI: $($metric.source_doi)."
        $source = $studiesByDoi[$metric.source_doi]
        Assert-True ($source.metrics_covered -ccontains $metric.metric_id) "$($metric.metric_id) is missing from $($source.id).metrics_covered."
        Assert-True ($metric.non_diagnostic_flag -is [bool] -and $metric.non_diagnostic_flag) "The non-diagnostic flag must be true for $($metric.metric_id)."
        foreach ($field in @('unit', 'anatomical_plane', 'stat_type', 'status')) {
            Assert-True ($metric.$field -is [string] -and $metricSchema.properties.$field.enum -ccontains $metric.$field) "$($metric.metric_id) has an invalid $field."
        }
        Assert-True ($metric.event_id -is [string] -and $definitions.event_id.enum -ccontains $metric.event_id) "$($metric.metric_id) has an invalid event ID."

        if ($metric.status -ceq 'pending_fulltext_extraction') {
            Assert-True ($null -eq $metric.sample_size -and $null -eq $metric.values -and
                $null -eq $metric.source_locator -and $null -eq $metric.cohort_notes) "Pending extraction cannot contain normative values for $($metric.metric_id)."
        } else {
            Assert-True ((Test-Integer $metric.sample_size) -and $metric.sample_size -ge 1) "Invalid sample size for $($metric.metric_id)."
            Assert-Text $metric.source_locator "$($metric.metric_id).source_locator"
            Assert-Text $metric.cohort_notes "$($metric.metric_id).cohort_notes"
            Assert-ObjectShape $metric.values $definitions.($metric.stat_type) "$($metric.metric_id).values"
            foreach ($value in $metric.values.PSObject.Properties.Value) {
                Assert-True ($value -is [ValueType] -and $value -isnot [bool] -and
                    -not [double]::IsInfinity($value) -and -not [double]::IsNaN($value)) "Expected finite numeric values for $($metric.metric_id)."
            }
            switch ($metric.stat_type) {
                'mean_sd' {
                    Assert-True ($metric.values.sd -ge 0) "Negative SD for $($metric.metric_id)."
                }
                'median_iqr' {
                    Assert-True ($metric.values.q1 -le $metric.values.median -and $metric.values.median -le $metric.values.q3) "Invalid quartile order for $($metric.metric_id)."
                }
                'threshold_range' {
                    Assert-True ($metric.values.lower -le $metric.values.upper) "Inverted range for $($metric.metric_id)."
                }
            }
            $null = $verifiedStudyDois.Add($metric.source_doi)
        }
    }
    foreach ($study in $catalog.studies) {
        $isVerified = $study.extraction_status -ceq 'verified_normative'
        Assert-True ($isVerified -eq $verifiedStudyDois.Contains($study.doi)) "Extraction status and normative metrics disagree for $($study.id)."
    }

    Write-Output "PASS: $($catalog.studies.Count) studies (baseball_pitching=$($domainCounts.baseball_pitching), running=$($domainCounts.running), jump_landing=$($domainCounts.jump_landing), standard_method=$($domainCounts.standard_method)); $($catalog.normative_metrics.Count) normative metrics."
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
