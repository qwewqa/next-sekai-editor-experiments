# /// script
# dependencies = ["pyyaml>=6"]
# ///
"""Our rules over the infrastructure in infra/, on top of cfn-lint. No AWS access.

    uv run infra/check_templates.py

A new service adds an entry to SERVICES and its own README table. A new resource type, or a change that
changes the monthly cost, fails here until it has been reviewed and recorded (infra/README.md, "Cost review").
"""

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
INFRA = ROOT / "infra"
ROLE_NAME = re.compile(r"^nse-(?P<service>[a-z]+)-(deploy|cfn)$")

# Per service: its template, its runbook, and every resource type its template may create.
# type: (tag property or None, billable cost note or None, checked by leftover.sh)
# A type absent from the table fails the check. A billable type also needs its id in the runbook's cost table.
SERVICES = {
    "shared": {
        "template": "account/account.yaml",
        "readme": "README.md",
        "types": {
            "AWS::IAM::OIDCProvider": ("Tags", None, False),
            "AWS::AccessAnalyzer::Analyzer": ("Tags", None, False),
            "AWS::IAM::Role": ("Tags", None, False),
            "AWS::SNS::Topic": ("Tags", None, False),
            "AWS::SNS::Subscription": (None, None, False),
            "AWS::Budgets::Budget": (None, None, False),
            "AWS::Route53::HostedZone": ("HostedZoneTags", "$0.50 a month per zone, retained", False),
        },
    },
    "stats": {
        "template": "stats/stats.yaml",
        "readme": "stats/README.md",
        "types": {
            "AWS::EC2::Instance": ("Tags", "t4g.small $0.0168 an hour in prod, t4g.micro $0.0084 in dev", True),
            "AWS::EC2::Volume": ("Tags", "gp3 $0.08 per GB-month, retained", True),
            "AWS::EC2::EIP": ("Tags", "public IPv4 $0.005 an hour, retained", True),
            "AWS::S3::Bucket": ("Tags", "S3 Standard $0.023 per GB-month, retained", True),
            "AWS::Route53::RecordSet": (None, "$0.40 per million queries", False),
            "AWS::CloudWatch::Alarm": ("Tags", "$0.10 a month per alarm, prod only", False),
            "AWS::EC2::SecurityGroup": ("Tags", None, False),
            "AWS::EC2::EIPAssociation": (None, None, False),
            "AWS::IAM::Role": ("Tags", None, False),
            "AWS::IAM::InstanceProfile": (None, None, False),
            "AWS::S3::BucketPolicy": (None, None, False),
        },
    },
    "assets": {
        "template": "assets/assets.yaml",
        "readme": "assets/README.md",
        "types": {
            "AWS::S3::Bucket": ("Tags", "S3 Standard $0.023 per GB-month, retained", False),
            "AWS::S3::BucketPolicy": (None, None, False),
            "AWS::IAM::Role": ("Tags", None, False),
        },
    },
}

# Settings that set the monthly cost. Changing one means updating the runbook's cost table and this table.
COST_PINS = {
    "stats/stats.yaml": {
        ("Mappings", "Sizes", "prod", "InstanceType"): "t4g.small",
        ("Mappings", "Sizes", "prod", "DataGiB"): 30,
        ("Mappings", "Sizes", "dev", "InstanceType"): "t4g.micro",
        ("Mappings", "Sizes", "dev", "DataGiB"): 10,
        # The properties that would set the same costs another way.
        ("Resources", "Instance", "Properties", "InstanceType"): {"Fn::FindInMap": ["Sizes", {"Ref": "Environment"}, "InstanceType"]},
        ("Resources", "Instance", "Properties", "CreditSpecification", "CPUCredits"): "standard",
        ("Resources", "Instance", "Properties", "BlockDeviceMappings", 0, "Ebs", "VolumeSize"): 8,
        ("Resources", "DataVolume", "Properties", "Size"): {"Fn::FindInMap": ["Sizes", {"Ref": "Environment"}, "DataGiB"]},
        ("Resources", "DataVolume", "Properties", "VolumeType"): "gp3",
        ("Resources", "DataVolume", "Properties", "Iops"): None,
        ("Resources", "DataVolume", "Properties", "Throughput"): None,
        ("Resources", "StatusAlarm", "Properties", "Period"): 60,
        ("Resources", "DumpBucket", "Properties", "LifecycleConfiguration", "Rules", 0, "ExpirationInDays"): 28,
    },
    "account/account.yaml": {
        ("Mappings", "Environments", "prod", "BudgetUsd"): "30",
        ("Mappings", "Environments", "dev", "BudgetUsd"): "1",
    },
}

# Retain, or RetainExceptOnCreate, which also deletes what a failed first create made.
RETAIN_POLICIES = {"Retain", "RetainExceptOnCreate"}
RETAINED_TYPES = {"AWS::EC2::Volume", "AWS::S3::Bucket", "AWS::EC2::EIP", "AWS::Route53::HostedZone"}
DESTRUCTIVE = {
    "cloudformation:DeleteStack",
    "ec2:DeleteVolume",
    "ec2:ReleaseAddress",
    "ec2:TerminateInstances",
    "s3:DeleteBucket",
    "s3:DeleteObject",
}
# Only the dev teardown (stats-dev-down.yml) may call delete-stack.
DELETE_STACK_FILES = re.compile(r"(^|/)(\w+-dev-down\.yml|dev-down\.sh)$")


class Loader(yaml.SafeLoader):
    pass


def _tag(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
        if suffix == "GetAtt":
            value = value.split(".", 1)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {"Ref" if suffix == "Ref" else f"Fn::{suffix}": value}


Loader.add_multi_constructor("!", _tag)


def load(path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=Loader)


def statements(role):
    """Yield (statement, prod) for each statement of a role's inline policies. prod is True, False or None."""
    for policy in role["Properties"].get("Policies", []):
        for item in policy["PolicyDocument"]["Statement"]:
            if "Fn::If" in item:
                cond, then, otherwise = item["Fn::If"]
                for branch, prod in ((then, True if cond == "IsProd" else None), (otherwise, False if cond == "IsProd" else None)):
                    if isinstance(branch, dict) and "Effect" in branch:
                        yield branch, prod
            else:
                yield item, None


def as_list(value):
    return value if isinstance(value, list) else [value]


def text(value):
    """A Sub string, or the string of a plain value."""
    if isinstance(value, dict) and "Fn::Sub" in value:
        value = value["Fn::Sub"]
        return value[0] if isinstance(value, list) else value
    return str(value)


def check_types_and_tags(name, service, template, readme, errors):
    table = service["types"]
    for rid, res in template["Resources"].items():
        kind = res["Type"]
        if kind not in table:
            errors.append(f"{name}: {rid} is {kind}, a resource type that has not been reviewed. Add it to SERVICES with a cost note.")
            continue
        tag_property, cost, _ = table[kind]
        if cost and kind not in readme:
            errors.append(f"{name}: {kind} is billable ({cost}) but missing from the cost table in {service['readme']}.")
        if kind in RETAINED_TYPES:
            for key in ("DeletionPolicy", "UpdateReplacePolicy"):
                if key == "DeletionPolicy" and res.get(key) not in RETAIN_POLICIES:
                    errors.append(f"{name}: {rid} must have DeletionPolicy: Retain or RetainExceptOnCreate.")
                if key == "UpdateReplacePolicy" and res.get(key) != "Retain":
                    errors.append(f"{name}: {rid} must have UpdateReplacePolicy: Retain.")
        if tag_property:
            tags = {t.get("Key"): t.get("Value") for t in res["Properties"].get(tag_property, []) if isinstance(t, dict)}
            expected = "shared" if name == "shared" else name
            if tags.get("nse:service") != expected:
                errors.append(f"{name}: {rid} needs the tag nse:service={expected}.")
            if "nse:env" not in tags:
                errors.append(f"{name}: {rid} needs the tag nse:env.")


def check_network_and_metadata(name, template, errors):
    for rid, res in template["Resources"].items():
        props = res.get("Properties", {})
        if res["Type"] == "AWS::EC2::SecurityGroup":
            for rule in props.get("SecurityGroupIngress", []):
                if (rule.get("IpProtocol"), rule.get("FromPort"), rule.get("ToPort")) != ("tcp", 443, 443):
                    errors.append(f"{name}: {rid} opens {rule}. Only TCP 443 may be open.")
        if res["Type"] == "AWS::EC2::Instance":
            if props.get("MetadataOptions", {}).get("HttpTokens") != "required":
                errors.append(f"{name}: {rid} must require IMDSv2 (HttpTokens: required).")
            if props.get("MetadataOptions", {}).get("HttpPutResponseHopLimit") != 1:
                errors.append(f"{name}: {rid} must set HttpPutResponseHopLimit: 1, so containers cannot use the instance role.")


def check_roles(name, template, errors):
    for rid, res in template["Resources"].items():
        if res["Type"] != "AWS::IAM::Role":
            continue
        role_name = res["Properties"]["RoleName"]
        match = ROLE_NAME.match(role_name)
        if name == "shared":
            if not match or match["service"] not in SERVICES:
                errors.append(f"shared: {rid} is named {role_name}; baseline roles are nse-<service>-deploy or nse-<service>-cfn.")
                continue
            service = match["service"]
        else:
            service = name
            if not role_name.startswith(f"nse-{service}-"):
                errors.append(f"{name}: {rid} is named {role_name}; a {service} role starts with nse-{service}-.")
        trust = res["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]
        if match and match["service"] == service and role_name.endswith("-deploy"):
            sub = trust["Condition"]["StringEquals"].get("token.actions.githubusercontent.com:sub")
            want = rf"repo:[^/@:]+@\d+/[^/@:]+@\d+:environment:{service}-\$\{{Environment\}}"
            if not re.fullmatch(want, text(sub) or ""):
                errors.append(f"shared: {rid} trusts {text(sub)!r}; it must trust one repository's {service}-<env> Environment, by its immutable subject.")
            if trust["Condition"]["StringEquals"].get("token.actions.githubusercontent.com:aud") != "sts.amazonaws.com":
                errors.append(f"shared: {rid} must require the audience sts.amazonaws.com.")
        if name == "shared" and match:
            check_role_policy(rid, res, errors)


def check_role_policy(rid, role, errors):
    """The deploy role may destroy only in dev, and in prod it denies DeleteStack. Scope is for the reviewer."""
    deploy = rid.endswith("DeployRole")
    deny_delete_in_prod = False
    for stmt, prod in statements(role):
        actions = as_list(stmt["Action"])
        if stmt["Effect"] == "Deny":
            deny_delete_in_prod |= prod is True and "cloudformation:DeleteStack" in actions
        elif deploy and DESTRUCTIVE & set(actions) and prod is not False:
            errors.append(f"{rid}/{stmt.get('Sid', '?')}: {sorted(DESTRUCTIVE & set(actions))} may be allowed in dev only.")
    if rid == "StatsCfnRole" and not any(s.get("Sid") == "NotTheBaselineRoles" and s["Effect"] == "Deny" for s, _ in statements(role)):
        errors.append(f"{rid}: the execution role must deny iam:* on the baseline roles (NotTheBaselineRoles).")
    if deploy and not deny_delete_in_prod:
        errors.append(f"{rid}: the prod deploy role needs an explicit deny of cloudformation:DeleteStack.")


def check_pins(name, template, errors):
    for key, want in COST_PINS.get(template_key(name), {}).items():
        node = template
        for part in key:
            try:
                node = node[part]
            except (KeyError, IndexError, TypeError):
                node = None
                break
        if node != want:
            errors.append(
                f"{'/'.join(map(str, key))} is {node!r}, pinned at {want!r}. It sets the monthly cost: "
                "update the cost table in the runbook and COST_PINS here."
            )


def template_key(name):
    return SERVICES[name]["template"]


def find_in_sites(value, key):
    """Whether value is FindInMap [Sites, Environment, key]."""
    return value == {"Fn::FindInMap": ["Sites", {"Ref": "Environment"}, key]}


def prefixed(value, path):
    """Whether value is the bucket ARN, then the site's prefix, then path (a Sub with the prefix from Sites)."""
    sub = value.get("Fn::Sub") if isinstance(value, dict) else None
    return (
        isinstance(sub, list)
        and sub[0] == f"${{Bucket.Arn}}/${{Prefix}}/{path}"
        and set(sub[1]) == {"Prefix"}
        and find_in_sites(sub[1]["Prefix"], "Prefix")
    )


def check_assets(errors):
    """The asset store keeps files by the deploy script's rule, never overwrites them, and gives the Pages
    workflow its own site's prefix only. Checked on actions, resources and conditions, not on statement names."""
    template = load(INFRA / "assets/assets.yaml")
    resources = template["Resources"]
    by_type = lambda kind: [res for res in resources.values() if res["Type"] == kind]
    for bucket in by_type("AWS::S3::Bucket"):
        props = bucket["Properties"]
        block = props.get("PublicAccessBlockConfiguration", {})
        if not all(block.get(k) is True for k in ("BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets")):
            errors.append("assets: the bucket must block all public access.")
        if "BucketEncryption" not in props:
            errors.append("assets: the bucket must be encrypted.")
        if "LifecycleConfiguration" in props or "VersioningConfiguration" in props:
            errors.append("assets: the bucket has no lifecycle rules or versioning; files expire by the deploy script's rule.")
    policies = by_type("AWS::S3::BucketPolicy")
    policy_statements = [st for pol in policies for st in pol["Properties"]["PolicyDocument"]["Statement"]]
    def denies(action, resource, condition):
        return any(
            st["Effect"] == "Deny" and st.get("Principal") == "*" and as_list(st["Action"]) == [action]
            and resource(as_list(st["Resource"])) and st.get("Condition") == condition
            for st in policy_statements
        )
    tls = lambda res: res == [{"Fn::GetAtt": ["Bucket", "Arn"]}, {"Fn::Sub": "${Bucket.Arn}/*"}]
    if not denies("s3:*", tls, {"Bool": {"aws:SecureTransport": "false"}}):
        errors.append("assets: the bucket policy must deny requests without TLS.")
    assets = lambda res: res == [{"Fn::Sub": "${Bucket.Arn}/*/assets/*"}]
    if not denies("s3:PutObject", assets, {"Null": {"s3:if-none-match": "true"}}):
        errors.append("assets: the bucket policy must deny a put to */assets/* without If-None-Match.")

    for name, site in template["Mappings"]["Sites"].items():
        if not re.fullmatch(r"repo:[^/@:]+@\d+/[^/@:]+@\d+:environment:github-pages", site["Subject"]):
            errors.append(f"assets: the {name} subject must be one repository's github-pages Environment, by its immutable subject.")
        if site["Ref"] != "refs/heads/main":
            errors.append(f"assets: the {name} ref must be refs/heads/main.")
    for role in by_type("AWS::IAM::Role"):
        trust = role["Properties"]["AssumeRolePolicyDocument"]["Statement"]
        want = {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": {"Fn::FindInMap": ["Sites", {"Ref": "Environment"}, "Subject"]},
            "token.actions.githubusercontent.com:ref": {"Fn::FindInMap": ["Sites", {"Ref": "Environment"}, "Ref"]},
        }
        provider = {"Fn::Sub": "arn:aws:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com"}
        if (
            len(trust) != 1
            or trust[0]["Effect"] != "Allow"
            or trust[0]["Action"] != "sts:AssumeRoleWithWebIdentity"
            or trust[0]["Principal"] != {"Federated": provider}
            or trust[0].get("Condition") != {"StringEquals": want}
        ):
            errors.append("assets: the role must trust only the GitHub provider, with the audience, subject and ref from Sites.")
        actions = set()
        for stmt, _ in statements(role):
            acts = as_list(stmt["Action"])
            actions |= set(acts)
            res = as_list(stmt["Resource"])
            if stmt["Effect"] != "Allow":
                errors.append("assets: the role's statements are all Allow.")
            elif acts == ["s3:ListBucket"]:
                listing = {"StringLike": {"s3:prefix": {"Fn::Sub": ["${Prefix}/assets/*", {"Prefix": {"Fn::FindInMap": ["Sites", {"Ref": "Environment"}, "Prefix"]}}]}}}
                if res != [{"Fn::GetAtt": ["Bucket", "Arn"]}] or stmt.get("Condition") != listing:
                    errors.append("assets: s3:ListBucket is on the bucket only, for the site's assets/ prefix.")
            elif "s3:ListBucket" in acts or not res:
                errors.append("assets: s3:ListBucket has a statement of its own.")
            else:
                paths = ["assets/*"] if "s3:DeleteObject" in acts else ["assets/*", "index.json"]
                if not all(any(prefixed(r, path) for path in paths) for r in res):
                    errors.append(f"assets: {acts} reach outside the site's {' and '.join(paths)}.")
        if actions != {"s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"}:
            errors.append(f"assets: the role's actions are {sorted(actions)}; only list, get, put and delete are allowed.")


def check_leftover(errors):
    markers = set(re.findall(r"# billable: (\S+)", (INFRA / "stats/scripts/leftover.sh").read_text(encoding="utf-8")))
    for kind, (_, _, checked) in SERVICES["stats"]["types"].items():
        if checked and kind not in markers:
            errors.append(f"stats/scripts/leftover.sh has no check for {kind}.")
    if "stack" not in markers:
        errors.append("stats/scripts/leftover.sh has no check for the stack.")


def check_host(errors):
    for line in (INFRA / "stats/host/images.env").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#") and not re.search(r"@sha256:[0-9a-f]{64}$", line):
            errors.append(f"images.env: {line.split('=')[0]} is not pinned by digest.")
    compose = yaml.safe_load((INFRA / "stats/host/compose.yaml").read_text(encoding="utf-8"))
    published = {str(p) for s in compose["services"].values() for p in s.get("ports", [])}
    if published != {"443:443", "127.0.0.1:3000:3000"}:
        errors.append(f"compose.yaml publishes {sorted(published)}; only 443 and Umami on 127.0.0.1 are allowed.")
    for key, s in compose["services"].items():
        if not str(s["image"]).startswith("${") or "_IMAGE" not in str(s["image"]):
            errors.append(f"compose.yaml: {key} must take its image from images.env.")


def check_workflows(errors):
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")) + sorted(INFRA.rglob("*.sh")):
        rel = path.relative_to(ROOT).as_posix()
        body = path.read_text(encoding="utf-8")
        if re.search(r"delete-stack|DeleteStack", body) and not DELETE_STACK_FILES.search(rel):
            errors.append(f"{rel}: delete-stack belongs only in a dev-down workflow or script.")
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
        if not re.match(r"(infra-check|stats-.*)\.yml$", path.name):
            continue
        rel = path.relative_to(ROOT).as_posix()
        body = path.read_text(encoding="utf-8")
        workflow = yaml.safe_load(body)
        triggers = workflow.get(True) or workflow.get("on")
        if "tags" in triggers or any(isinstance(v, dict) and "tags" in v for v in triggers.values()):
            errors.append(f"{rel}: infra workflows never run on a tag.")
        if re.search(r"secrets\.(?!GITHUB_TOKEN)", body):
            errors.append(f"{rel}: infra workflows use OIDC roles and no stored secrets.")
        for ref in re.findall(r"uses:\s*(\S+)", body):
            if not ref.startswith("./") and not re.search(r"@[0-9a-f]{40}$", ref):
                errors.append(f"{rel}: {ref} is not pinned to a commit.")
    down = (ROOT / ".github/workflows/stats-dev-down.yml").read_text(encoding="utf-8")
    if "environment: stats-dev\n" not in down:
        errors.append("stats-dev-down.yml must use only the Environment stats-dev.")


def main():
    errors = []
    for name, service in SERVICES.items():
        path = INFRA / service["template"]
        template = load(path)
        readme = (INFRA / service["readme"]).read_text(encoding="utf-8")
        if path.stat().st_size >= 51200:
            errors.append(f"{name}: the template is over 51,200 bytes, so it would need an S3 bucket to deploy.")
        check_types_and_tags(name, service, template, readme, errors)
        check_network_and_metadata(name, template, errors)
        check_roles(name, template, errors)
        check_pins(name, template, errors)
    check_assets(errors)
    check_leftover(errors)
    check_host(errors)
    check_workflows(errors)
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    print(f"{len(errors)} problem(s)" if errors else "infra: all rules pass")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
