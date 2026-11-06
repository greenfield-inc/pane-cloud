# The fleet host AMI: Ubuntu 24.04 arm64 plus setup-host.sh. Building it launches an instance, so it
# waits for the Pane Cloud AWS account (D-21). Validate without AWS: packer init . && packer validate .
packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.3"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "build_instance_type" {
  # Baking needs no KVM; any Graviton instance builds an image that runs on r7g.metal.
  type    = string
  default = "c7g.large"
}

source "amazon-ebs" "fleet_host" {
  region        = var.region
  instance_type = var.build_instance_type
  ami_name      = "pane-cloud-fleet-host-{{timestamp}}"
  ssh_username  = "ubuntu"
  # Encrypted root volume; the snapshot backing the AMI is encrypted with the account's default key.
  encrypt_boot = true
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_endpoint               = "enabled"
  }
  tags = {
    Name      = "pane-cloud-fleet-host"
    component = "fleet-host"
  }
}

build {
  sources = ["source.amazon-ebs.fleet_host"]

  provisioner "file" {
    source      = "${path.root}/"
    destination = "/tmp/fleet-host"
  }

  provisioner "shell" {
    inline = ["sudo bash /tmp/fleet-host/setup-host.sh", "sudo rm -rf /tmp/fleet-host"]
  }
}
