"""Generate an ephemeral localhost/127.0.0.1 certificate for this synthetic HTTPS probe."""
import ipaddress
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


target = Path(sys.argv[1]).resolve()
target.mkdir(parents=True, exist_ok=True)
key = ec.generate_private_key(ec.SECP256R1())
now = datetime.now(timezone.utc)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Gate G local test only")])
cert = (
    x509.CertificateBuilder()
    .subject_name(name)
    .issuer_name(name)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - timedelta(minutes=1))
    .not_valid_after(now + timedelta(days=2))
    .add_extension(
        x509.SubjectAlternativeName(
            [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
        ),
        critical=False,
    )
    .sign(key, hashes.SHA256())
)
(target / "localhost-key.pem").write_bytes(
    key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
)
(target / "localhost-cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
print(target / "localhost-cert.pem")
